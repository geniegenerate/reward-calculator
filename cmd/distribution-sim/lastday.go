package main

import (
	"encoding/json"
	"math"
	"os"
	"sort"

	"github.com/geniegenerate/backend/internal/reward/rewardcalc"
)

// creditEdges bound the last-day credit bands. Each position completed one
// $1.00 discount, so an edge of 1 is "the position's own discount".
var creditEdges = []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 50, 100, 300, math.Inf(1)}

type band struct {
	Lo    float64  `json:"lo"`
	Hi    *float64 `json:"hi"` // null = no upper bound
	Count int      `json:"count"`
	Sum   float64  `json:"sum"`
	Min   float64  `json:"min"`
	Max   float64  `json:"max"`
}

type rankRange struct {
	Lo       int     `json:"lo"`
	Hi       int     `json:"hi"`
	Loyalty  float64 `json:"loyalty_avg"`
	Newcomer float64 `json:"newcomer_avg"`
	Below    float64 `json:"below_own_pct"`
}

type loop struct {
	N            int     `json:"loop"`
	Participants int     `json:"participants"`
	Distributed  float64 `json:"distributed"`
	Final        bool    `json:"final,omitempty"`
	Surplus      bool    `json:"surplus,omitempty"`
}

type lastDay struct {
	Participants     int         `json:"participants"`
	OwnDiscount      float64     `json:"own_discount"` // bands and rank ranges are in multiples of this
	LoyaltyPoolIn    float64     `json:"loyalty_pool_in"`
	NewcomerPoolIn   float64     `json:"newcomer_pool_in"`
	LoyaltyCredited  float64     `json:"loyalty_credited"`
	NewcomerCredited float64     `json:"newcomer_credited"`
	TomorrowPool     float64     `json:"tomorrow_pool"`
	NewcomerCap      float64     `json:"newcomer_cap"`
	Bands            []band      `json:"credit_bands"`
	Ranks            []rankRange `json:"rank_ranges"`
	Loops            []loop      `json:"newcomer_loops"`
}

// writeLastDay records one day. Pools are in dollars (a $1.00 target each);
// credit bands and rank ranges are in multiples of the position's own
// discount, own = 1 + extra.
func writeLastDay(path string, out rewardcalc.Output, in rewardcalc.Input, own float64) error {
	d := lastDay{Participants: len(out.Members), OwnDiscount: own, LoyaltyPoolIn: in.LoyaltyPool.InexactFloat64(), NewcomerPoolIn: in.NewcomerPool.InexactFloat64(),
		TomorrowPool: out.TomorrowPool.InexactFloat64(), NewcomerCap: out.NewcomerCap.InexactFloat64()}
	bands := make([]band, len(creditEdges))
	for i, e := range creditEdges {
		if i > 0 {
			bands[i].Lo = creditEdges[i-1]
		}
		if !math.IsInf(e, 1) {
			hi := e
			bands[i].Hi = &hi
		}
		bands[i].Min = math.Inf(1)
	}
	ms := append([]rewardcalc.MemberResult(nil), out.Members...)
	sort.Slice(ms, func(i, j int) bool { return ms[i].LoyaltyRank < ms[j].LoyaltyRank })
	for _, m := range ms {
		l, n := m.LoyaltyReward.InexactFloat64(), m.NewcomerReward.InexactFloat64()
		t := m.TotalReward.InexactFloat64() / own
		d.LoyaltyCredited += l
		d.NewcomerCredited += n
		for i, e := range creditEdges {
			if t < e {
				b := &bands[i]
				b.Count++
				b.Sum += t
				b.Min, b.Max = math.Min(b.Min, t), math.Max(b.Max, t)
				break
			}
		}
	}
	for _, b := range bands {
		if b.Count > 0 {
			d.Bands = append(d.Bands, b)
		}
	}
	for i, lo := range rankEdges {
		if lo > len(ms) {
			break
		}
		hi := len(ms)
		if i+1 < len(rankEdges) && rankEdges[i+1]-1 < hi {
			hi = rankEdges[i+1] - 1
		}
		r := rankRange{Lo: lo, Hi: hi}
		below := 0
		for _, m := range ms[lo-1 : hi] {
			r.Loyalty += m.LoyaltyReward.InexactFloat64() / own
			r.Newcomer += m.NewcomerReward.InexactFloat64() / own
			if m.TotalReward.InexactFloat64() < own {
				below++
			}
		}
		c := float64(hi - lo + 1)
		r.Loyalty, r.Newcomer, r.Below = r.Loyalty/c, r.Newcomer/c, 100*float64(below)/c
		d.Ranks = append(d.Ranks, r)
	}
	for _, l := range out.NewcomerLoops {
		d.Loops = append(d.Loops, loop{N: l.LoopNumber, Participants: l.Participants, Distributed: l.Distributed.InexactFloat64(), Final: l.IsFinal, Surplus: l.IsSurplus})
	}
	b, err := json.MarshalIndent(d, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
