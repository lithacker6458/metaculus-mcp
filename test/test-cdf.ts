import {
  nominalToCdfLocation,
  buildCdfFromPercentiles,
  validateCdf,
} from "/Users/anishboddu/Documents/Projects/HoleFill/mcp-server/src/cdf";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1. Linear scaling from the spec's worked example: NYC temperature, range -40..110.
const linearQ = {
  id: 1,
  type: "numeric",
  open_lower_bound: true,
  open_upper_bound: true,
  inbound_outcome_count: 200,
  scaling: { range_min: -40, range_max: 110, zero_point: null },
};
check("linear loc(-40)=0", Math.abs(nominalToCdfLocation(-40, linearQ)) < 1e-12);
check("linear loc(110)=1", Math.abs(nominalToCdfLocation(110, linearQ) - 1) < 1e-12);
check("linear loc(35)=0.5", Math.abs(nominalToCdfLocation(35, linearQ) - 0.5) < 1e-12);

// 2. Log scaling from the spec's example response: COVID deaths question,
//    scaling { range_min: 200, range_max: 100000000, zero_point: 0.0 }.
const logQ = {
  id: 2,
  type: "numeric",
  open_lower_bound: true,
  open_upper_bound: true,
  inbound_outcome_count: 200,
  scaling: { range_min: 200, range_max: 100000000, zero_point: 0.0 },
};
check("log loc(200)=0", Math.abs(nominalToCdfLocation(200, logQ)) < 1e-9);
check("log loc(1e8)=1", Math.abs(nominalToCdfLocation(100000000, logQ) - 1) < 1e-9);
// With zero_point=0 the scale is pure log: midpoint = geometric mean sqrt(200*1e8)
const mid = Math.sqrt(200 * 100000000);
check("log loc(geo-mean)=0.5", Math.abs(nominalToCdfLocation(mid, logQ) - 0.5) < 1e-6,
  String(nominalToCdfLocation(mid, logQ)));

// 3. Full CDF build, open/open bounds — must produce 201 valid points.
const cdf1 = buildCdfFromPercentiles(
  { "5": -10, "25": 5, "50": 15, "75": 25, "95": 40 },
  linearQ,
  0.02,
  0.03,
);
check("open/open cdf length 201", cdf1.length === 201, String(cdf1.length));
check("open/open cdf[0] >= 0.001", cdf1[0]! >= 0.001, String(cdf1[0]));
check("open/open cdf[200] <= 0.999", cdf1[200]! <= 0.999, String(cdf1[200]));
try {
  validateCdf(cdf1, linearQ);
  check("open/open validateCdf passes", true);
} catch (e) {
  check("open/open validateCdf passes", false, (e as Error).message);
}

// 4. Closed/closed bounds — cdf[0] must be exactly 0, last exactly 1.
const closedQ = {
  id: 3,
  type: "numeric",
  open_lower_bound: false,
  open_upper_bound: false,
  inbound_outcome_count: 200,
  scaling: { range_min: 0, range_max: 100, zero_point: null },
};
const cdf2 = buildCdfFromPercentiles(
  { "10": 0, "50": 50, "90": 100 },
  closedQ,
);
check("closed/closed cdf[0] == 0", cdf2[0] === 0, String(cdf2[0]));
check("closed/closed cdf[200] == 1", cdf2[200] === 1, String(cdf2[200]));

// 5. Discrete question with inbound_outcome_count = 10 (spec example 3) -> 11 points.
const discreteQ = {
  id: 4,
  type: "discrete",
  open_lower_bound: false,
  open_upper_bound: false,
  inbound_outcome_count: 10,
  scaling: { range_min: 0, range_max: 10, zero_point: null, inbound_outcome_count: 10 },
};
const cdf3 = buildCdfFromPercentiles({ "20": 2, "50": 5, "80": 8 }, discreteQ);
check("discrete cdf length 11", cdf3.length === 11, String(cdf3.length));
check("discrete cdf[0]==0 cdf[10]==1", cdf3[0] === 0 && cdf3[10] === 1);

// 6. Error paths: percentiles not encompassing bounds without outside-mass hints.
try {
  buildCdfFromPercentiles({ "25": 40, "75": 60 }, linearQ);
  check("non-encompassing sketch rejected", false);
} catch {
  check("non-encompassing sketch rejected", true);
}

// 7. Spiky distribution must be rejected (max step rule), not silently reshaped.
try {
  const spiky = buildCdfFromPercentiles(
    { "1": 49.9, "99": 50.1 },
    closedQ,
  );
  check("spiky sketch rejected", false, `built len=${spiky.length}`);
} catch (e) {
  check("spiky sketch rejected", (e as Error).message.includes("cap"), (e as Error).message.slice(0, 80));
}

console.log(failures === 0 ? "ALL CDF TESTS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
