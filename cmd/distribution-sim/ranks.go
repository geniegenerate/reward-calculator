package main

import (
	"fmt"
	"sort"

	"github.com/geniegenerate/backend/internal/reward/rewardcalc"
	"github.com/shopspring/decimal"
)

// dayInput builds one day's calculator input. Without poolSeeds it is the
// V5 shape ($1.00 loyalty pool per participant, deducted by the calculator).
// With poolSeeds it is the AlgoV6 shape: the fee left at payment, the loyalty
// pool is $0.92 per participant of which $0.02 is the seed, and the fresh
// newcomer inflow carries a seed of 2/92 of itself.
func dayInput(ps []rewardcalc.Participant, newcomerPool decimal.Decimal, fresh float64, poolSeeds bool) rewardcalc.Input {
	n := decimal.NewFromInt(int64(len(ps)))
	if !poolSeeds {
		return rewardcalc.Input{Participants: ps, LoyaltyPool: n, NewcomerPool: newcomerPool}
	}
	return rewardcalc.Input{
		Participants: ps,
		LoyaltyPool:  n.Mul(decimal.RequireFromString("0.92")),
		NewcomerPool: newcomerPool,
		PoolSeeds: &rewardcalc.PoolSeeds{
			Loyalty:  n.Mul(decimal.RequireFromString("0.02")),
			Newcomer: decimal.NewFromFloat(fresh).Mul(decimal.NewFromInt(2)).Div(decimal.NewFromInt(92)).Truncate(6),
		},
	}
}

var rankEdges = []int{1, 2, 11, 101, 1001, 10001, 50001, 100001, 150001}

// printRankBands prints, per loyalty-rank range, the average loyalty, newcomer
// and total credit in dollars. Each position completed one $1.00 Daily
// Challenge discount, so a total below 1.00 is less than that discount.
func printRankBands(out rewardcalc.Output) {
	ms := append([]rewardcalc.MemberResult(nil), out.Members...)
	sort.Slice(ms, func(i, j int) bool { return ms[i].LoyaltyRank < ms[j].LoyaltyRank })
	n := len(ms)
	fmt.Printf("\nlast day by loyalty rank (%d participants; each completed a $1.00 discount):\n", n)
	fmt.Printf("  %-15s %9s %10s %10s %10s %10s %10s %8s\n", "rank", "members", "loyalty", "newcomer", "total", "min", "max", "< $1.00")
	var tl, tn float64
	for i, lo := range rankEdges {
		if lo > n {
			break
		}
		hi := n
		if i+1 < len(rankEdges) && rankEdges[i+1]-1 < n {
			hi = rankEdges[i+1] - 1
		}
		var sl, sn float64
		mn, mx, below := -1.0, 0.0, 0
		for _, m := range ms[lo-1 : hi] {
			l, nw := m.LoyaltyReward.InexactFloat64(), m.NewcomerReward.InexactFloat64()
			t := m.TotalReward.InexactFloat64()
			sl, sn = sl+l, sn+nw
			if mn < 0 || t < mn {
				mn = t
			}
			if t > mx {
				mx = t
			}
			if t < 1 {
				below++
			}
		}
		tl, tn = tl+sl, tn+sn
		c := float64(hi - lo + 1)
		fmt.Printf("  %7d-%-7d %9d %10.3f %10.3f %10.3f %10.3f %10.3f %7.1f%%\n", lo, hi, hi-lo+1, sl/c, sn/c, (sl+sn)/c, mn, mx, 100*float64(below)/c)
	}
	fmt.Printf("  %-15s %9d %10.3f %10.3f %10.3f\n", "all", n, tl/float64(n), tn/float64(n), (tl+tn)/float64(n))
}

func printNewcomerLoops(out rewardcalc.Output) {
	fmt.Printf("\nlast day newcomer loops (cap per position $%s):\n", out.NewcomerCap.StringFixed(3))
	fmt.Printf("  %5s %12s %12s %14s\n", "loop", "members", "distributed", "per member")
	for _, l := range out.NewcomerLoops {
		tag := ""
		if l.IsFinal {
			tag = " final"
		}
		if l.IsSurplus {
			tag = " surplus"
		}
		d := l.Distributed.InexactFloat64()
		per := 0.0
		if l.Participants > 0 {
			per = d / float64(l.Participants)
		}
		fmt.Printf("  %5d %12d %12.2f %14.4f%s\n", l.LoopNumber, l.Participants, d, per, tag)
	}
}
