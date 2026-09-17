// Command distribution-sim runs the published reward algorithm over a
// synthetic member population for one or more consecutive days and prints the
// shape of the resulting distribution: per-day leaderboard turnover, income
// bands (member counts and the actual min/max credited in each band), and
// cumulative totals. It exists so anyone can see what the algorithm does at a
// given scale without needing production data.
//
// It is a development tool, not part of the on-chain artifact: it is never
// compiled into calculator.wasm (see README "What's here").
//
//	go run ./cmd/distribution-sim -members 50000 -days 30 -newcomer-pool 50000 -carry -scenario longtail
//
// Scenarios (how loyalty scores are seeded on day 1):
//
//	equal        every member has LS 1 (launch day / closed cohort)
//	uniform      LS uniform in 1..30, everyone completes daily
//	longtail     geometric LS (most low, few high), everyone completes daily
//	cohort       signup age + per-member completion rate; LS = days completed;
//	             a member takes part only on days it completes
//	cohort-shops cohort plus a per-member "distinct shops per day", crediting
//	             the +1-per-10-qualifying-payments-per-shop source
//
// The loyalty pool is $1.00 per participant that day (one completed Daily
// Challenge each). The newcomer pool is -newcomer-pool per day, plus the
// previous day's Tomorrow Newcomer Pool when -carry is set. Every amount is
// what the algorithm credits, before wallet-capacity clamping matters (capacity
// is set to 10,000).
package main

import (
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"

	"github.com/geniegenerate/backend/internal/reward/rewardcalc"
	"github.com/shopspring/decimal"
)

type member struct {
	key      int64
	age      int     // days since signup
	rate     float64 // probability of completing the Daily Challenge on a given day
	shops    int     // distinct shops paid per active day (cohort-shops only)
	ls       int
	progress int // qualifying payments toward the next +1 (per 10, cohort-shops only)
	life     decimal.Decimal
}

var bandEdges = []float64{0.10, 0.25, 0.50, 1, 2, 5, 10, 50, 100, 300, 1000, 5000, math.Inf(1)}
var bandNames = []string{"< $0.10", "$0.10-0.25", "$0.25-0.50", "$0.50-1", "$1-2", "$2-5", "$5-10", "$10-50", "$50-100", "$100-300", "$300-1000", "$1000-5000", ">= $5000"}

func main() {
	members := flag.Int("members", 50000, "population size")
	days := flag.Int("days", 1, "consecutive distribution days to simulate")
	ncPool := flag.Float64("newcomer-pool", 0, "fresh newcomer-pool inflow per day (USD)")
	carry := flag.Bool("carry", false, "add the previous day's Tomorrow Newcomer Pool to the next day's newcomer pool")
	scenario := flag.String("scenario", "uniform", "equal | uniform | longtail | cohort | cohort-shops")
	seed := flag.Int64("seed", 42, "random seed (deterministic per seed)")
	flag.Parse()

	r := rand.New(rand.NewSource(*seed))
	pop := seedPopulation(*members, *scenario, r)
	fmt.Printf("scenario=%s members=%d days=%d newcomer-pool=%.0f/day carry=%v seed=%d\n", *scenario, *members, *days, *ncPool, *carry, *seed)
	printLSSummary(pop)

	cum := make(map[int64]float64, *members)
	leaderDays := map[int64]int{}
	everOver100 := map[int64]bool{}
	var prevTop10, prevNcTop100, prevOver100 map[int64]bool
	carryOver := decimal.Zero
	trace := map[int64][]float64{}
	var traceKeys []int64
	traceName := map[int64]string{}

	fmt.Println()
	fmt.Println("day | participants | newcomer pool (carried) | loyalty #1 | top10 loyalty kept | top100 newcomer kept | >=$100 today | of which repeat | max | min | median")
	for d := 1; d <= *days; d++ {
		ps, active := participantsForDay(pop, *scenario, r)
		if len(ps) == 0 {
			fmt.Printf("%3d | 0 participants — nothing to distribute\n", d)
			continue
		}
		pool := decimal.NewFromFloat(*ncPool)
		if *carry {
			pool = pool.Add(carryOver)
		}
		out := rewardcalc.Compute(rewardcalc.Input{Participants: ps, LoyaltyPool: decimal.NewFromInt(int64(len(ps))), NewcomerPool: pool})
		carryOver = out.TomorrowPool

		totals := make(map[int64]float64, len(out.Members))
		newcomer := make(map[int64]float64, len(out.Members))
		loyaltyRank := make(map[int64]int, len(out.Members))
		over := map[int64]bool{}
		var leader int64
		vals := make([]float64, 0, len(out.Members))
		for _, m := range out.Members {
			t, _ := m.TotalReward.Float64()
			nv, _ := m.NewcomerReward.Float64()
			totals[m.OrderingKey], newcomer[m.OrderingKey], loyaltyRank[m.OrderingKey] = t, nv, m.LoyaltyRank
			cum[m.OrderingKey] += t
			pop[m.OrderingKey-1].life = pop[m.OrderingKey-1].life.Add(m.TotalReward).Round(6)
			vals = append(vals, t)
			if t >= 100 {
				over[m.OrderingKey] = true
				everOver100[m.OrderingKey] = true
			}
			if m.LoyaltyRank == 1 {
				leader = m.OrderingKey
			}
		}
		sort.Float64s(vals)
		leaderDays[leader]++
		top10 := topN(totals, loyaltyRank, 10)
		ncTop100 := topByValue(newcomer, 100)
		if d == 1 {
			traceKeys = []int64{leader, keyOfMax(newcomer), ps[len(ps)/2].OrderingKey}
			traceName[traceKeys[0]] = "day-1 loyalty #1"
			traceName[traceKeys[1]] = "day-1 newcomer #1"
			traceName[traceKeys[2]] = "a mid-list member"
			printDayBands(vals, sumFloat(vals))
		}
		for _, k := range traceKeys {
			trace[k] = append(trace[k], totals[k])
		}
		kept10, keptNc, repeat := -1, -1, -1
		if prevTop10 != nil {
			kept10, keptNc, repeat = overlap(top10, prevTop10), overlap(ncTop100, prevNcTop100), overlap(over, prevOver100)
		}
		if d <= 10 || d%10 == 0 || d == *days {
			fmt.Printf("%3d | %6d | $%s ($%s) | #%d (LS %d) | %d/10 | %d/100 | %d | %d | $%.2f | $%.2f | $%.2f\n",
				d, len(ps), pool.StringFixed(0), pool.Sub(decimal.NewFromFloat(*ncPool)).StringFixed(0), leader, pop[leader-1].ls, kept10, keptNc, len(over), repeat, vals[len(vals)-1], vals[0], vals[len(vals)/2])
		}
		prevTop10, prevNcTop100, prevOver100 = top10, ncTop100, over
		advanceDay(pop, active, *scenario)
	}

	if *days > 1 {
		printCumulative(pop, cum, *days, everOver100, leaderDays)
		fmt.Println()
		fmt.Println("per-day credit of three tracked members (first 10 days, then the last):")
		for _, k := range traceKeys {
			fmt.Printf("  %-20s", traceName[k])
			for i, v := range trace[k] {
				if i < 10 || i == len(trace[k])-1 {
					fmt.Printf(" %8.2f", v)
				}
			}
			fmt.Printf("   cumulative $%.2f\n", cum[k])
		}
	}
}

func seedPopulation(n int, scenario string, r *rand.Rand) []member {
	pop := make([]member, n)
	for i := range pop {
		m := member{key: int64(i + 1), rate: 1, shops: 1}
		switch scenario {
		case "equal":
			m.ls = 1
		case "uniform":
			m.ls = 1 + r.Intn(30)
		case "longtail":
			m.ls = 1
			for r.Float64() < 0.8 && m.ls < 200 {
				m.ls++
			}
		case "cohort", "cohort-shops":
			m.age = int(math.Min(365, -math.Log(r.Float64())*120)) + 1 // accelerating signups: many recent members
			u := r.Float64()
			m.rate = 0.05 + 0.95*u*u // skewed toward casual members
			if scenario == "cohort-shops" {
				switch x := r.Float64(); {
				case x < 0.60:
					m.shops = 1
				case x < 0.85:
					m.shops = 2
				case x < 0.95:
					m.shops = 3
				case x < 0.99:
					m.shops = 5
				default:
					m.shops = 8
				}
			}
			for d := 0; d < m.age; d++ {
				if r.Float64() < m.rate {
					m.ls++
					if scenario == "cohort-shops" {
						m.progress += m.shops
						m.ls += m.progress / 10
						m.progress %= 10
					}
				}
			}
		default:
			fmt.Fprintf(os.Stderr, "unknown scenario %q\n", scenario)
			os.Exit(2)
		}
		// Prior lifetime earnings loosely track tenure; only the ORDER matters to the newcomer sort.
		m.life = decimal.NewFromFloat(float64(m.ls) * 0.3 * (0.5 + r.Float64())).Round(6)
		pop[i] = m
	}
	return pop
}

func participantsForDay(pop []member, scenario string, r *rand.Rand) ([]rewardcalc.Participant, []int) {
	var ps []rewardcalc.Participant
	var active []int
	for i := range pop {
		if r.Float64() < pop[i].rate {
			ps = append(ps, rewardcalc.Participant{OrderingKey: pop[i].key, LoyaltyScore: pop[i].ls, LifetimeEarnings: pop[i].life, WalletBalance: decimal.Zero, MaxCapacity: decimal.NewFromInt(10000)})
			active = append(active, i)
		}
	}
	perm := r.Perm(len(ps)) // completion order is random each day
	for i := range ps {
		ps[i].CompletionRank = int64(perm[i] + 1)
	}
	return ps, active
}

func advanceDay(pop []member, active []int, scenario string) {
	for _, i := range active {
		pop[i].ls++
		if scenario == "cohort-shops" {
			pop[i].progress += pop[i].shops
			pop[i].ls += pop[i].progress / 10
			pop[i].progress %= 10
		}
	}
	for i := range pop {
		pop[i].age++
	}
}

func printLSSummary(pop []member) {
	v := make([]float64, len(pop))
	rateSum := 0.0
	for i := range pop {
		v[i] = float64(pop[i].ls)
		rateSum += pop[i].rate
	}
	sort.Float64s(v)
	fmt.Printf("day-1 loyalty score: min %.0f | p25 %.0f | median %.0f | p75 %.0f | p99 %.0f | max %.0f | mean completion rate %.0f%%\n", v[0], pct(v, .25), pct(v, .5), pct(v, .75), pct(v, .99), v[len(v)-1], 100*rateSum/float64(len(pop)))
}

func printDayBands(vals []float64, credited float64) {
	fmt.Printf("\nday 1 income bands (%d participants, $%.0f credited):\n", len(vals), credited)
	printBands(vals, credited)
}

func printCumulative(pop []member, cum map[int64]float64, days int, everOver100 map[int64]bool, leaderDays map[int64]int) {
	vals := make([]float64, 0, len(pop))
	for i := range pop {
		vals = append(vals, cum[pop[i].key])
	}
	sort.Float64s(vals)
	total := sumFloat(vals)
	n := len(vals)
	top1, top10 := 0.0, 0.0
	for i, v := range vals {
		if i >= n-n/100 {
			top1 += v
		}
		if i >= n-n/10 {
			top10 += v
		}
	}
	fmt.Printf("\ncumulative over %d days ($%.0f credited): min $%.2f | p25 $%.2f | median $%.2f | p75 $%.2f | p90 $%.2f | p99 $%.2f | max $%.2f\n", days, total, vals[0], pct(vals, .25), pct(vals, .5), pct(vals, .75), pct(vals, .9), pct(vals, .99), vals[n-1])
	fmt.Printf("top 1%% of members hold %.0f%% of the money, top 10%% hold %.0f%% | members with at least one >=$100 day: %d | distinct loyalty #1 holders: %d\n", 100*top1/total, 100*top10/total, len(everOver100), len(leaderDays))
	fmt.Printf("cumulative income bands:\n")
	printBands(vals, total)
}

func printBands(vals []float64, total float64) {
	count := make([]int, len(bandEdges))
	sum := make([]float64, len(bandEdges))
	lo := make([]float64, len(bandEdges))
	hi := make([]float64, len(bandEdges))
	for b := range lo {
		lo[b] = math.Inf(1)
	}
	for _, v := range vals {
		for b, e := range bandEdges {
			if v < e {
				count[b]++
				sum[b] += v
				lo[b] = math.Min(lo[b], v)
				hi[b] = math.Max(hi[b], v)
				break
			}
		}
	}
	fmt.Printf("  %-12s %9s %7s %12s %7s   %s\n", "band", "members", "%", "money", "%", "actual min - max")
	for b := range bandEdges {
		if count[b] == 0 {
			continue
		}
		fmt.Printf("  %-12s %9d %6.1f%% %12.0f %6.1f%%   $%.2f - $%.2f\n", bandNames[b], count[b], 100*float64(count[b])/float64(len(vals)), sum[b], 100*sum[b]/total, lo[b], hi[b])
	}
}

func topN(totals map[int64]float64, rank map[int64]int, n int) map[int64]bool {
	s := map[int64]bool{}
	for k, r := range rank {
		if r <= n {
			s[k] = true
		}
	}
	_ = totals
	return s
}

func topByValue(vals map[int64]float64, n int) map[int64]bool {
	type kv struct {
		k int64
		v float64
	}
	arr := make([]kv, 0, len(vals))
	for k, v := range vals {
		arr = append(arr, kv{k, v})
	}
	sort.Slice(arr, func(a, b int) bool { return arr[a].v > arr[b].v })
	s := map[int64]bool{}
	for i := 0; i < n && i < len(arr); i++ {
		s[arr[i].k] = true
	}
	return s
}

func keyOfMax(vals map[int64]float64) int64 {
	var best int64
	bestV := -1.0
	for k, v := range vals {
		if v > bestV || (v == bestV && k < best) {
			best, bestV = k, v
		}
	}
	return best
}

func overlap(a, b map[int64]bool) int {
	c := 0
	for k := range a {
		if b[k] {
			c++
		}
	}
	return c
}

func sumFloat(v []float64) float64 {
	s := 0.0
	for _, x := range v {
		s += x
	}
	return s
}

func pct(sorted []float64, q float64) float64 { return sorted[int(float64(len(sorted)-1)*q)] }
