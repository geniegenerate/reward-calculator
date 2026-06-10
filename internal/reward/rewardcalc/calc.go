// Package rewardcalc is the single, canonical, self-contained implementation of
// the GenieGenerate reward-distribution math.
//
// TRUST-MODEL CONTRACT (see backend/specs/reward-verification-trustless):
//   - This package has ZERO dependencies beyond the Go standard library and
//     github.com/shopspring/decimal. No DB, no uuid, no time.Time, no I/O,
//     no globals, no randomness, no float arithmetic in money paths.
//   - It is a PURE function: Compute(input) -> output, deterministic across OS,
//     CPU architecture, and WASM runtime. The exact same source is compiled to
//     WASM and published; keccak256(wasm) is the on-chain algorithm_id.
//   - Members are identified ONLY by OrderingKey (the canonical 1-indexed sort
//     position frozen in the committed snapshot). No real identity ever enters
//     this package, so the published calculator operates on pseudonymised data.
//
// Any change to this file that alters output for the same input is, by
// definition, a new algorithm version and requires a new on-chain announcement.
package rewardcalc

import (
	"math/bits"
	"sort"

	"github.com/shopspring/decimal"
)

// ============================================================================
// Canonical input / output schema (mirrors the committed snapshot)
// ============================================================================

// Participant is one row of the frozen, pseudonymised input snapshot.
// OrderingKey is the stable identity: unique, 1-indexed, the absolute final
// tiebreaker so no two participants ever compare equal.
type Participant struct {
	OrderingKey      int64           `json:"ordering_key"`
	LoyaltyScore     int             `json:"loyalty_score"`
	CompletionRank   int64           `json:"completion_rank"`   // monotonic completion ordinal (earlier = smaller); lossless replacement for time.Time comparisons
	LifetimeEarnings decimal.Decimal `json:"lifetime_earnings"` // 6dp
	WalletBalance    decimal.Decimal `json:"wallet_balance"`    // spending+earning combined, 6dp
	MaxCapacity      decimal.Decimal `json:"max_capacity"`      // 6dp
}

// Input is the complete, self-contained input to a distribution computation.
// Everything needed to reproduce the result offline is here — no external state.
type Input struct {
	Participants []Participant   `json:"participants"`
	LoyaltyPool  decimal.Decimal `json:"loyalty_pool"`  // original pool balance, 6dp
	NewcomerPool decimal.Decimal `json:"newcomer_pool"` // original pool balance incl. carry-forward, 6dp
}

// MemberResult is one row of the result file.
type MemberResult struct {
	OrderingKey    int64           `json:"ordering_key"`
	LoyaltyReward  decimal.Decimal `json:"loyalty_reward"`  // 6dp
	NewcomerReward decimal.Decimal `json:"newcomer_reward"` // 6dp
	TotalReward    decimal.Decimal `json:"total_reward"`    // 6dp
	CreditedAmount decimal.Decimal `json:"credited_amount"` // 6dp, ≤ TotalReward when over capacity
	ExcessAmount   decimal.Decimal `json:"excess_amount"`   // 6dp
	WasOverCap     bool            `json:"was_over_cap"`
	LoyaltyRank    int             `json:"loyalty_rank"` // 1-indexed loyalty-leaderboard position
}

// LoopResult is the per-loop newcomer breakdown (rank + credit per participant).
type LoopResult struct {
	LoopNumber   int                       `json:"loop_number"`
	Participants int                       `json:"participants"`
	Distributed  decimal.Decimal           `json:"distributed"`
	IsFinal      bool                      `json:"is_final"`
	Ranks        map[int64]int             `json:"ranks"`   // OrderingKey -> 1-based loop rank
	Credits      map[int64]decimal.Decimal `json:"credits"` // OrderingKey -> per-loop credit
}

// Output is the complete, deterministic result of a distribution computation.
type Output struct {
	Members           []MemberResult  `json:"members"`
	NewcomerLoops     []LoopResult    `json:"newcomer_loops"`
	NewcomerCap       decimal.Decimal `json:"newcomer_cap"`
	LoyaltyUnclaimed  decimal.Decimal `json:"loyalty_unclaimed"`
	TomorrowPool      decimal.Decimal `json:"tomorrow_pool"`
	TotalCredited     decimal.Decimal `json:"total_credited"`
	TotalParticipants int             `json:"total_participants"`
}

// ============================================================================
// Constants (must match grid_compute.go exactly)
// ============================================================================

var (
	fourteen      = decimal.NewFromInt(14)
	deductionRate = decimal.RequireFromString("0.10")
	keepRate      = decimal.RequireFromString("0.30")
	minLoopPool   = decimal.RequireFromString("1.00")
	maxLoopCount  = 1000
)

// ============================================================================
// Compute — the single canonical orchestration
// (mirrors distribute_rewards.go lines 119-149, pure portion only)
// ============================================================================

// Compute runs the full distribution math and returns the deterministic result.
// Pure function: identical Input -> identical Output, bit-for-bit.
func Compute(in Input) Output {
	loyaltyDeduction := applyDeduction(in.LoyaltyPool)
	newcomerDeduction := applyDeduction(in.NewcomerPool)
	tomorrowPool := loyaltyDeduction.tomorrow.Add(newcomerDeduction.tomorrow)
	chargedLoyaltyPool := loyaltyDeduction.charged
	chargedNewcomerPool := newcomerDeduction.charged

	loyaltySorted := sortLoyalty(in.Participants)
	loyaltyRanks := ranksFromSorted(loyaltySorted)
	loyaltyGrid, loyaltyUnclaimed := computeGridRewards(loyaltySorted, chargedLoyaltyPool)
	loyaltyKeep, loyaltyToNewcomer := applyLoyaltySplit(loyaltyGrid)
	chargedNewcomerPool = chargedNewcomerPool.Add(loyaltyToNewcomer).Add(loyaltyUnclaimed)

	newcomerCap := decimal.Zero
	for _, keep := range loyaltyKeep {
		if keep.GreaterThan(newcomerCap) {
			newcomerCap = keep
		}
	}

	newcomerRewards, newcomerTomorrow, loops := computeNewcomerLoops(
		in.Participants, chargedNewcomerPool, newcomerCap, loyaltyKeep,
	)
	tomorrowPool = tomorrowPool.Add(newcomerTomorrow)

	members, capacityExcess := applyWalletCapacity(in.Participants, loyaltyKeep, newcomerRewards, loyaltyRanks)
	tomorrowPool = tomorrowPool.Add(capacityExcess)

	totalCredited := decimal.Zero
	for _, m := range members {
		totalCredited = totalCredited.Add(m.CreditedAmount)
	}

	return Output{
		Members:           members,
		NewcomerLoops:     loops,
		NewcomerCap:       newcomerCap,
		LoyaltyUnclaimed:  loyaltyUnclaimed,
		TomorrowPool:      tomorrowPool,
		TotalCredited:     totalCredited,
		TotalParticipants: len(in.Participants),
	}
}

// ============================================================================
// Pure helpers (ported verbatim from grid_compute.go, keyed by OrderingKey)
// ============================================================================

type deduction struct {
	charged  decimal.Decimal
	tomorrow decimal.Decimal
}

// applyDeduction: 10% off the pool; 80% of that to platform, 20% to tomorrow.
func applyDeduction(pool decimal.Decimal) deduction {
	if pool.IsZero() || pool.IsNegative() {
		return deduction{charged: decimal.Zero, tomorrow: decimal.Zero}
	}
	ded := pool.Mul(deductionRate).Truncate(6)
	platformAmt := ded.Mul(decimal.RequireFromString("0.80")).Truncate(6)
	tomorrowAmt := ded.Sub(platformAmt) // remainder to avoid dust loss
	return deduction{charged: pool.Sub(ded), tomorrow: tomorrowAmt}
}

// sortLoyalty: LoyaltyScore DESC → CompletionRank ASC → LifetimeEarnings DESC → OrderingKey ASC.
func sortLoyalty(participants []Participant) []Participant {
	sorted := make([]Participant, len(participants))
	copy(sorted, participants)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.LoyaltyScore != b.LoyaltyScore {
			return a.LoyaltyScore > b.LoyaltyScore
		}
		if a.CompletionRank != b.CompletionRank {
			return a.CompletionRank < b.CompletionRank
		}
		if !a.LifetimeEarnings.Equal(b.LifetimeEarnings) {
			return a.LifetimeEarnings.GreaterThan(b.LifetimeEarnings)
		}
		return a.OrderingKey < b.OrderingKey
	})
	return sorted
}

// sortNewcomer: LifetimeEarnings ASC → CompletionRank ASC → LoyaltyScore DESC → OrderingKey DESC.
func sortNewcomer(participants []Participant) []Participant {
	sorted := make([]Participant, len(participants))
	copy(sorted, participants)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if !a.LifetimeEarnings.Equal(b.LifetimeEarnings) {
			return a.LifetimeEarnings.LessThan(b.LifetimeEarnings)
		}
		if a.CompletionRank != b.CompletionRank {
			return a.CompletionRank < b.CompletionRank
		}
		if a.LoyaltyScore != b.LoyaltyScore {
			return a.LoyaltyScore > b.LoyaltyScore
		}
		return a.OrderingKey > b.OrderingKey
	})
	return sorted
}

// computeGridRewards distributes a pool through the 14-rank binary-tree grid.
func computeGridRewards(sorted []Participant, pool decimal.Decimal) (map[int64]decimal.Decimal, decimal.Decimal) {
	n := len(sorted)
	rewards := make(map[int64]decimal.Decimal, n)
	if n == 0 || pool.IsZero() || pool.IsNegative() {
		return rewards, pool
	}
	nDec := decimal.NewFromInt(int64(n))
	perPart := pool.Div(nDec).Div(fourteen).Truncate(6)
	if perPart.IsZero() {
		return rewards, pool
	}
	totalDistributed := decimal.Zero
	for i := range n {
		pos := i + 1
		rank := gridRank(pos)
		ranksAbove := rank - 1
		partsSentUp := minInt(ranksAbove, 13)
		// Parts the member cannot send up (no rank above) are RETURNED to the
		// member (REWARD_SYSTEM.md v3.7), folded into their grid reward before
		// the caller's 30/70 keep-forward split — exactly like the base kept
		// part. They no longer flow out to the pool.
		returnedParts := 13 - partsSentUp
		descendantCount := countDescendants(pos, n, 13)
		memberTotal := perPart.Mul(decimal.NewFromInt(int64(1 + descendantCount + returnedParts))).Truncate(6)
		rewards[sorted[i].OrderingKey] = memberTotal
		totalDistributed = totalDistributed.Add(memberTotal)
	}
	// Only rounding dust remains as carry-forward.
	dust := pool.Sub(totalDistributed)
	return rewards, dust
}

// applyLoyaltySplit: 30% keep / 70% → newcomer pool.
func applyLoyaltySplit(gridRewards map[int64]decimal.Decimal) (map[int64]decimal.Decimal, decimal.Decimal) {
	keepRewards := make(map[int64]decimal.Decimal, len(gridRewards))
	toNewcomer := decimal.Zero
	for key, total := range gridRewards {
		keep := total.Mul(keepRate).Truncate(6)
		keepRewards[key] = keep
		toNewcomer = toNewcomer.Add(total.Sub(keep))
	}
	return keepRewards, toNewcomer
}

// computeNewcomerLoops runs the progressive newcomer loops.
func computeNewcomerLoops(
	allParticipants []Participant,
	pool decimal.Decimal,
	newcomerCap decimal.Decimal,
	loyaltyKeep map[int64]decimal.Decimal,
) (map[int64]decimal.Decimal, decimal.Decimal, []LoopResult) {
	rewards := make(map[int64]decimal.Decimal)
	tomorrowPool := decimal.Zero
	loops := []LoopResult{}
	if pool.IsZero() || pool.IsNegative() {
		return rewards, tomorrowPool, loops
	}

	participants := make([]Participant, len(allParticipants))
	copy(participants, allParticipants)
	if loyaltyKeep != nil {
		for i, p := range participants {
			if reward, ok := loyaltyKeep[p.OrderingKey]; ok {
				participants[i].LifetimeEarnings = p.LifetimeEarnings.Add(reward)
			}
		}
	}

	capEnforced := newcomerCap.IsPositive()
	loopPool := pool

	for loopN := 1; loopN <= maxLoopCount; loopN++ {
		eligible := filterByMinLS(participants, loopN)
		if len(eligible) == 0 {
			tomorrowPool = tomorrowPool.Add(loopPool)
			break
		}
		nextEligible := filterByMinLS(participants, loopN+1)
		isFinal := len(eligible) <= 15 || loopPool.LessThanOrEqual(minLoopPool) || len(nextEligible) == 0

		record := LoopResult{LoopNumber: loopN, Participants: len(eligible), IsFinal: isFinal}

		if isFinal {
			record.Ranks = ranksFromSorted(sortNewcomer(eligible))
			record.Credits = make(map[int64]decimal.Decimal, len(eligible))
			nDec := decimal.NewFromInt(int64(len(eligible)))
			perMember := loopPool.Div(nDec).Truncate(6)
			distributed := decimal.Zero
			for _, p := range eligible {
				credit := perMember
				if capEnforced {
					remaining := newcomerCap.Sub(rewards[p.OrderingKey])
					if remaining.IsNegative() {
						remaining = decimal.Zero
					}
					if credit.GreaterThan(remaining) {
						tomorrowPool = tomorrowPool.Add(credit.Sub(remaining))
						credit = remaining
					}
				}
				rewards[p.OrderingKey] = rewards[p.OrderingKey].Add(credit)
				record.Credits[p.OrderingKey] = credit
				distributed = distributed.Add(credit)
			}
			dust := loopPool.Sub(perMember.Mul(nDec))
			if dust.IsPositive() {
				tomorrowPool = tomorrowPool.Add(dust)
			}
			record.Distributed = distributed
			loops = append(loops, record)
			break
		}

		sorted := sortNewcomer(eligible)
		record.Ranks = ranksFromSorted(sorted)
		record.Credits = make(map[int64]decimal.Decimal, len(eligible))
		for _, p := range eligible {
			record.Credits[p.OrderingKey] = decimal.Zero
		}
		gridRewards, gridUnclaimed := computeGridRewards(sorted, loopPool)
		nextLoopPool := gridUnclaimed
		distributed := decimal.Zero
		for _, p := range eligible {
			memberGrid := gridRewards[p.OrderingKey]
			if memberGrid.IsZero() {
				continue
			}
			keep30 := memberGrid.Mul(keepRate).Truncate(6)
			to70 := memberGrid.Sub(keep30)
			credit := keep30
			if capEnforced {
				remaining := newcomerCap.Sub(rewards[p.OrderingKey])
				if remaining.IsNegative() {
					remaining = decimal.Zero
				}
				if credit.GreaterThan(remaining) {
					nextLoopPool = nextLoopPool.Add(credit.Sub(remaining))
					credit = remaining
				}
			}
			rewards[p.OrderingKey] = rewards[p.OrderingKey].Add(credit)
			record.Credits[p.OrderingKey] = credit
			distributed = distributed.Add(credit)
			nextLoopPool = nextLoopPool.Add(to70)
		}
		record.Distributed = distributed
		loops = append(loops, record)
		loopPool = nextLoopPool

		// Update earnings so the next loop's sort reflects who has the least.
		for i, p := range participants {
			if credit, ok := rewards[p.OrderingKey]; ok {
				participants[i].LifetimeEarnings = allParticipants[i].LifetimeEarnings.Add(credit)
				if lr, ok2 := loyaltyKeep[p.OrderingKey]; ok2 {
					participants[i].LifetimeEarnings = participants[i].LifetimeEarnings.Add(lr)
				}
			}
		}
	}

	if capEnforced {
		for key, total := range rewards {
			if total.GreaterThan(newcomerCap) {
				tomorrowPool = tomorrowPool.Add(total.Sub(newcomerCap))
				rewards[key] = newcomerCap
			}
		}
	}
	return rewards, tomorrowPool, loops
}

// applyWalletCapacity caps combined rewards at each member's remaining capacity
// and emits the final per-member result rows (sorted by OrderingKey for
// deterministic output ordering).
func applyWalletCapacity(
	participants []Participant,
	loyaltyRewards map[int64]decimal.Decimal,
	newcomerRewards map[int64]decimal.Decimal,
	loyaltyRanks map[int64]int,
) ([]MemberResult, decimal.Decimal) {
	members := make([]MemberResult, 0, len(participants))
	excess := decimal.Zero
	for _, p := range participants {
		loyalty := loyaltyRewards[p.OrderingKey]
		newcomer := newcomerRewards[p.OrderingKey]
		total := loyalty.Add(newcomer)
		if total.IsZero() {
			continue
		}
		remaining := remainingCapacity(p)
		credited := total
		memberExcess := decimal.Zero
		wasOverCap := false
		if total.GreaterThan(remaining) {
			credited = remaining.Truncate(6)
			memberExcess = total.Sub(credited)
			wasOverCap = true
			excess = excess.Add(memberExcess)
		}
		members = append(members, MemberResult{
			OrderingKey:    p.OrderingKey,
			LoyaltyReward:  loyalty,
			NewcomerReward: newcomer,
			TotalReward:    total,
			CreditedAmount: credited,
			ExcessAmount:   memberExcess,
			WasOverCap:     wasOverCap,
			LoyaltyRank:    loyaltyRanks[p.OrderingKey],
		})
	}
	sort.SliceStable(members, func(i, j int) bool {
		return members[i].OrderingKey < members[j].OrderingKey
	})
	return members, excess
}

func remainingCapacity(p Participant) decimal.Decimal {
	remaining := p.MaxCapacity.Sub(p.WalletBalance)
	if remaining.IsNegative() {
		return decimal.Zero
	}
	return remaining
}

func ranksFromSorted(sorted []Participant) map[int64]int {
	ranks := make(map[int64]int, len(sorted))
	for i, p := range sorted {
		ranks[p.OrderingKey] = i + 1
	}
	return ranks
}

// gridRank returns the 1-indexed binary-tree depth of a position.
// Integer bit-length — exact and deterministic, replacing the float
// math.Floor(math.Log2(pos))+1 in grid_compute.go (which is a latent
// cross-platform determinism risk). For all pos>0 the two agree.
func gridRank(pos int) int {
	if pos <= 0 {
		return 0
	}
	return bits.Len(uint(pos))
}

func countDescendants(pos, totalNodes, maxDepth int) int {
	count := 0
	for d := 1; d <= maxDepth; d++ {
		startPos := pos * (1 << d)
		if startPos > totalNodes {
			break
		}
		endPos := minInt(startPos+(1<<d)-1, totalNodes)
		count += endPos - startPos + 1
	}
	return count
}

func filterByMinLS(participants []Participant, minScore int) []Participant {
	result := make([]Participant, 0)
	for _, p := range participants {
		if p.LoyaltyScore >= minScore {
			result = append(result, p)
		}
	}
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
