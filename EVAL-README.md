# Route Runner Evaluation System

Automated testing system for validating route generation quality.

## What It Tests

### 1. Distance Accuracy
- ✅ Route distance within 0.5 miles of requested distance
- Example: "5 mile loop" should generate 4.5-5.5 miles

### 2. Elevation Accuracy  
- ✅ Elevation gain within 100 feet of requested constraint (if specified)
- Example: "no more than 500ft elevation" should have ≤600ft gain

### 3. Landmark Proximity
- ✅ Route passes within 0.1 miles of all requested landmarks
- Example: "through Kerry Park" should pass within 0.1mi of Kerry Park

### 4. Route Characteristics
- ✅ Loop vs point-to-point verification
- ✅ Scenic/waterfront preferences (using Claude analysis)
- ✅ Start/end point accuracy

## Setup

```bash
cd ~/route-runner-api

# Install dependencies (if needed)
npm install

# Make sure your dev server is running
npm run dev
```

## Usage

### Run All Tests

```bash
# Test against local development server
node eval-system.js

# Test against production
WORKER_URL=https://your-worker.workers.dev node eval-system.js

# Include Claude AI analysis (requires API key)
ANTHROPIC_API_KEY=sk-ant-xxx node eval-system.js
```

### Run Specific Test

```bash
node eval-system.js --test "Simple 5 mile loop"
```

### See All Options

```bash
node eval-system.js --help
```

## Test Cases

The system includes 4 default test cases:

1. **Simple 5 mile loop** - Basic distance and loop validation
2. **10 mile loop with elevation** - Distance + elevation constraint
3. **Route with waypoints** - Multi-point route through specific landmarks
4. **Waterfront scenic route** - Preference-based routing

## Output Example

```
============================================================
Testing: Simple 5 mile loop
Query: "5 mile loop from Space Needle"
============================================================

✓ Route generated successfully
  Route ID: abc-123
  Distance: 5.1 miles
  Elevation: 245 feet
  Turns: 12
  Duration: 51 minutes
  Is Loop: Yes

Validation Results:
  ✅ PASSED - All criteria met

Claude Analysis:
  Match: Yes
  Score: 95/100
```

## Adding Custom Tests

Edit `eval-system.js` and add to the `TEST_CASES` array:

```javascript
{
  name: "My custom test",
  query: "6 mile scenic loop avoiding hills",
  location: { lat: 47.6062, lng: -122.3321 },
  expected: {
    distanceMin: 5.5,
    distanceMax: 6.5,
    elevationMax: 200,
    isLoop: true,
    preferences: {
      scenic: true
    }
  }
}
```

## Expected Criteria Format

```javascript
expected: {
  // Distance validation
  distanceMin: 4.5,        // minimum miles
  distanceMax: 5.5,        // maximum miles
  
  // Elevation validation (optional)
  elevationMax: 500,       // maximum feet of gain
  
  // Route type
  isLoop: true,            // true for loop, false for point-to-point
  
  // Waypoint validation (optional)
  waypoints: [
    {
      lat: 47.6205,
      lng: -122.3493,
      name: "Space Needle",
      maxDistance: 0.1     // must pass within 0.1 miles
    }
  ],
  
  // Preferences (requires Claude analysis)
  preferences: {
    scenic: true,
    waterfront: true
  }
}
```

## CI/CD Integration

Add to your GitHub Actions or CI pipeline:

```yaml
- name: Run Route Evals
  run: |
    npm run dev &
    sleep 5
    node eval-system.js
  env:
    WORKER_URL: http://localhost:8787
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Interpreting Results

### ✅ PASSED
All validation criteria met. Route quality is good.

### ❌ FAILED  
One or more criteria not met. Check the "Issues" section for details.

Common failures:
- Distance outside acceptable range
- Missing or too far from waypoints
- Wrong route type (loop vs point-to-point)
- Elevation exceeds constraint

## Claude Analysis (Optional)

When `ANTHROPIC_API_KEY` is set, the system uses Claude to:
- Verify route characteristics match the natural language request
- Identify qualitative issues (e.g., "not scenic enough")
- Provide an overall quality score (0-100)

This adds ~$0.001 per test but provides deeper insights.

## Troubleshooting

**"Connection refused"**
- Make sure your dev server is running (`npm run dev`)
- Check the WORKER_URL is correct

**"Route does not pass through X"**
- Mapbox might have routed around the landmark
- Try increasing `maxDistance` tolerance
- Check if landmark coordinates are accurate

**All tests failing**
- Verify your worker is responding: `curl http://localhost:8787/api/generate-route`
- Check API secrets are set: `wrangler secret list`
- Look at worker logs: `wrangler tail`

## Continuous Monitoring

Run evals regularly to catch regressions:

```bash
# Daily cron job
0 0 * * * cd ~/route-runner-api && WORKER_URL=https://your-worker.workers.dev node eval-system.js
```

## Next Steps

1. **Run your first eval**: `node eval-system.js`
2. **Add custom test cases** for your specific use cases
3. **Integrate with CI/CD** for automated testing
4. **Monitor trends** - track success rates over time
