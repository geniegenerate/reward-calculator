package rewardcalc

// AlgoV5 additions (REWARD_SYSTEM v3.58 Fix 2 + Fix 3): the post-deduction
// restoration and its carry, and the program-end final round. Same contract as
// calc.go: pure, standard library + decimal only, no float in a money path.

import (
	"errors"
	"sort"

	"github.com/shopspring/decimal"
)

// Final-round modes.
const (
	// FinalModeAfterRound: the boundary's normal round runs first, then every
	// amount it would have carried is shared (a company decision's end).
	FinalModeAfterRound = "after_round"
	// FinalModeOnly: no normal round; every pool balance is shared (insolvency,
	// or 90 days without partner acceptance).
	FinalModeOnly = "only"
)

// Final-round recipient bases (Rules 11.4). The calculator shares among the input
// participants either way; the basis records which set the platform supplied.
const (
	RecipientsRoundEligible = "round_eligible"
	RecipientsPrior30Days   = "prior_30_days"
)

// FinalRound selects the program-end final distribution.
type FinalRound struct {
	Mode           string `json:"mode"`
	RecipientBasis string `json:"recipient_basis"`
}

// FinalRoundResult summarises the final distribution.
type FinalRoundResult struct {
	Mode           string          `json:"mode"`
	RecipientBasis string          `json:"recipient_basis"`
	Amount         decimal.Decimal `json:"amount"`          // everything shared, 6dp
	PerMember      decimal.Decimal `json:"per_member"`      // floor(Amount / Recipients, 6dp)
	RemainderUnits int64           `json:"remainder_units"` // 0.000001 units given to the lowest ordering keys
	Recipients     int             `json:"recipients"`
}

var microUnit = decimal.New(1, -6)

// Validate refuses an input the algorithm cannot honour. ComputeJSON calls it, so
// the published calculator rejects such a snapshot rather than guessing.
func Validate(in Input) error {
	if in.NewcomerRestoration != nil && in.NewcomerRestoration.IsNegative() {
		return errors.New("newcomer_restoration must not be negative")
	}
	f := in.FinalRound
	if f == nil {
		return nil
	}
	switch f.Mode {
	case FinalModeAfterRound:
		if f.RecipientBasis != RecipientsRoundEligible {
			return errors.New("final_round after_round shares among the round's eligible members only")
		}
	case FinalModeOnly:
		if f.RecipientBasis != RecipientsRoundEligible && f.RecipientBasis != RecipientsPrior30Days {
			return errors.New("final_round recipient_basis must be round_eligible or prior_30_days")
		}
	default:
		return errors.New("final_round mode must be after_round or only")
	}
	if len(in.Participants) == 0 {
		return errors.New("final_round needs at least one recipient")
	}
	return nil
}

func restorationOf(in Input) decimal.Decimal {
	if in.NewcomerRestoration == nil {
		return decimal.Zero
	}
	return *in.NewcomerRestoration
}

// splitRestorationCarry returns the restoration-origin part of the round's carry:
// its pro-rata share of the non-seed carry, ceil(C × R / A, 6dp), at most C.
// Rounded up because both parts are members' money and this one must never meet a
// deduction (founder decision 2026-10-23).
func splitRestorationCarry(carry decimal.Decimal, loyalty, newcomer deduction, restoration decimal.Decimal) decimal.Decimal {
	nonSeed := carry.Sub(loyalty.tomorrow).Sub(newcomer.tomorrow)
	allocated := loyalty.charged.Add(newcomer.charged).Add(restoration)
	if !nonSeed.IsPositive() || !allocated.IsPositive() {
		return decimal.Zero
	}
	share := nonSeed.Mul(restoration).Div(allocated).RoundCeil(6)
	if share.GreaterThan(nonSeed) {
		return nonSeed
	}
	return share
}

// computeFinalOnly shares every pool balance with no round and no deduction.
func computeFinalOnly(in Input) Output {
	amount := in.LoyaltyPool.Add(in.NewcomerPool).Add(restorationOf(in))
	members := make([]MemberResult, 0, len(in.Participants))
	for _, p := range in.Participants {
		members = append(members, MemberResult{OrderingKey: p.OrderingKey, LoyaltyReward: decimal.Zero,
			NewcomerReward: decimal.Zero, TotalReward: decimal.Zero, CreditedAmount: decimal.Zero, ExcessAmount: decimal.Zero})
	}
	out := Output{
		Members:           members,
		NewcomerLoops:     []LoopResult{},
		NewcomerCap:       decimal.Zero,
		LoyaltyUnclaimed:  decimal.Zero,
		TomorrowPool:      decimal.Zero,
		TotalCredited:     decimal.Zero,
		TotalParticipants: len(in.Participants),
	}
	return shareFinal(in, out, amount)
}

// withFinalRound shares everything the round would have carried.
func withFinalRound(in Input, out Output, loyaltyRanks map[int64]int) Output {
	amount := out.TomorrowPool
	if out.TomorrowRestorationCarry != nil {
		amount = amount.Add(*out.TomorrowRestorationCarry)
	}
	has := make(map[int64]bool, len(out.Members))
	for _, m := range out.Members {
		has[m.OrderingKey] = true
	}
	for _, p := range in.Participants {
		if !has[p.OrderingKey] {
			out.Members = append(out.Members, MemberResult{OrderingKey: p.OrderingKey, LoyaltyReward: decimal.Zero,
				NewcomerReward: decimal.Zero, TotalReward: decimal.Zero, CreditedAmount: decimal.Zero,
				ExcessAmount: decimal.Zero, LoyaltyRank: loyaltyRanks[p.OrderingKey]})
		}
	}
	out.TomorrowPool = decimal.Zero
	out.TomorrowRestorationCarry = nil
	return shareFinal(in, out, amount)
}

// shareFinal gives every member row floor(amount / N, 6dp), then one 0.000001 to
// each of the lowest ordering keys until the remainder is spent, so the shares sum
// to amount exactly. No wallet-capacity cap: after the end there is no carry.
func shareFinal(in Input, out Output, amount decimal.Decimal) Output {
	sort.SliceStable(out.Members, func(i, j int) bool { return out.Members[i].OrderingKey < out.Members[j].OrderingKey })
	n := decimal.NewFromInt(int64(len(out.Members)))
	per := amount.Div(n).Truncate(6)
	remainder := amount.Sub(per.Mul(n)).Div(microUnit).IntPart()
	for i := range out.Members {
		share := per
		if int64(i) < remainder {
			share = share.Add(microUnit)
		}
		out.Members[i].FinalShare = &share
	}
	out.FinalRound = &FinalRoundResult{Mode: in.FinalRound.Mode, RecipientBasis: in.FinalRound.RecipientBasis,
		Amount: amount, PerMember: per, RemainderUnits: remainder, Recipients: len(out.Members)}
	return out
}
