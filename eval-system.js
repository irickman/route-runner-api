/**
 * Route Runner Evaluation System
 * 
 * Tests the quality of generated routes against various criteria:
 * 1. Distance accuracy (within 0.5 miles)
 * 2. Elevation accuracy (within 100 feet if specified)
 * 3. Landmark proximity (within 0.1 miles of requested points)
 * 4. Route characteristics (loop vs point-to-point, etc.)
 */

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Test cases with expected results
const TEST_CASES = [
  {
    name: "Simple 5 mile loop",
    query: "5 mile loop from Space Needle",
    location: { lat: 47.6205, lng: -122.3493 },
    expected: {
      distanceMin: 4.5,
      distanceMax: 5.5,
      isLoop: true,
      startPoint: { lat: 47.6205, lng: -122.3493, name: "Space Needle" }
    }
  },
  {
    name: "10 mile loop with elevation constraint",
    query: "10 mile loop with no more than 500 feet of elevation gain",
    location: { lat: 47.6205, lng: -122.3493 },
    expected: {
      distanceMin: 9.5,
      distanceMax: 10.5,
      elevationMax: 600, // Allow 100 ft buffer
      isLoop: true
    }
  },
  {
    name: "Route with specific waypoints",
    query: "5 mile route from Space Needle through Kerry Park",
    location: { lat: 47.6205, lng: -122.3493 },
    expected: {
      distanceMin: 4.5,
      distanceMax: 5.5,
      waypoints: [
        { lat: 47.6205, lng: -122.3493, name: "Space Needle", maxDistance: 0.1 },
        { lat: 47.6295, lng: -122.3598, name: "Kerry Park", maxDistance: 0.1 }
      ]
    }
  },
  {
    name: "Waterfront scenic route",
    query: "3 mile scenic waterfront route",
    location: { lat: 47.6062, lng: -122.3321 },
    expected: {
      distanceMin: 2.5,
      distanceMax: 3.5,
      preferences: {
        scenic: true,
        waterfront: true
      }
    }
  }
];

// Haversine distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Check if route passes near a waypoint
function checkWaypointProximity(routeCoordinates, waypoint) {
  let minDistance = Infinity;
  
  for (const coord of routeCoordinates) {
    const distance = calculateDistance(
      waypoint.lat, waypoint.lng,
      coord[1], coord[0] // Note: GeoJSON is [lng, lat]
    );
    minDistance = Math.min(minDistance, distance);
  }
  
  return minDistance;
}

// Check if route is a loop (start and end within 0.05 miles)
function isLoop(coordinates) {
  if (coordinates.length < 2) return false;
  
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  
  const distance = calculateDistance(
    start[1], start[0],
    end[1], end[0]
  );
  
  return distance < 0.05; // Within 0.05 miles
}

// Validate a single route against expected criteria
function validateRoute(routeData, expected) {
  const results = {
    passed: true,
    failures: [],
    details: {}
  };
  
  // Check distance
  if (expected.distanceMin !== undefined || expected.distanceMax !== undefined) {
    const actualDistance = routeData.stats.distanceMiles || routeData.stats.distance_miles;
    results.details.distance = {
      actual: actualDistance,
      expected: `${expected.distanceMin}-${expected.distanceMax} miles`,
      passed: actualDistance >= expected.distanceMin && actualDistance <= expected.distanceMax
    };
    
    if (!results.details.distance.passed) {
      results.passed = false;
      results.failures.push(
        `Distance ${actualDistance.toFixed(2)} miles is outside expected range ${expected.distanceMin}-${expected.distanceMax} miles`
      );
    }
  }
  
  // Check elevation
  if (expected.elevationMax !== undefined) {
    const actualElevation = routeData.stats.elevationGainFeet || routeData.stats.elevation_gain_feet;
    results.details.elevation = {
      actual: actualElevation,
      expected: `<= ${expected.elevationMax} feet`,
      passed: actualElevation <= expected.elevationMax
    };
    
    if (!results.details.elevation.passed) {
      results.passed = false;
      results.failures.push(
        `Elevation ${actualElevation} feet exceeds maximum ${expected.elevationMax} feet`
      );
    }
  }
  
  // Check if it's a loop
  if (expected.isLoop !== undefined) {
    const actualIsLoop = isLoop(routeData.geometry.coordinates);
    results.details.isLoop = {
      actual: actualIsLoop,
      expected: expected.isLoop,
      passed: actualIsLoop === expected.isLoop
    };
    
    if (!results.details.isLoop.passed) {
      results.passed = false;
      results.failures.push(
        `Route ${actualIsLoop ? 'is' : 'is not'} a loop, but expected ${expected.isLoop ? 'loop' : 'point-to-point'}`
      );
    }
  }
  
  // Check waypoint proximity
  if (expected.waypoints) {
    results.details.waypoints = [];
    
    for (const waypoint of expected.waypoints) {
      const minDistance = checkWaypointProximity(
        routeData.geometry.coordinates,
        waypoint
      );
      
      const waypointPassed = minDistance <= waypoint.maxDistance;
      results.details.waypoints.push({
        name: waypoint.name,
        minDistance: minDistance.toFixed(3),
        maxAllowed: waypoint.maxDistance,
        passed: waypointPassed
      });
      
      if (!waypointPassed) {
        results.passed = false;
        results.failures.push(
          `Route does not pass within ${waypoint.maxDistance} miles of ${waypoint.name} (closest: ${minDistance.toFixed(3)} miles)`
        );
      }
    }
  }
  
  return results;
}

// Use Claude to analyze route characteristics
async function analyzeWithClaude(query, routeData) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  No ANTHROPIC_API_KEY set, skipping Claude analysis');
    return { analyzed: false };
  }
  
  const prompt = `Analyze this running route request and actual route data. Does the generated route match what was requested?

REQUEST: "${query}"

ROUTE DATA:
- Distance: ${routeData.stats.distanceMiles || routeData.stats.distance_miles} miles
- Elevation Gain: ${routeData.stats.elevationGainFeet || routeData.stats.elevation_gain_feet} feet
- Number of Turns: ${routeData.stats.numberOfTurns || routeData.stats.num_turns}
- Duration: ${routeData.stats.estimatedDurationMinutes || routeData.stats.duration_minutes} minutes
- Is Loop: ${isLoop(routeData.geometry.coordinates)}

Evaluate:
1. Does the distance match the request? (within 0.5 miles is acceptable)
2. Does the elevation match if specified? (within 100 feet is acceptable)
3. Does it satisfy any special characteristics mentioned (scenic, waterfront, loop, etc.)?

Respond with a JSON object:
{
  "matches_request": boolean,
  "issues": [list of any issues],
  "score": number from 0-100
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    const data = await response.json();
    const content = data.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('Claude analysis error:', error.message);
  }
  
  return { analyzed: false };
}

// Run a single test case
async function runTest(testCase) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${testCase.name}`);
  console.log(`Query: "${testCase.query}"`);
  console.log('='.repeat(60));
  
  try {
    // Generate route
    const response = await fetch(`${WORKER_URL}/api/generate-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: testCase.query,
        location: testCase.location
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error: ${error}`);
    }
    
    const routeData = await response.json();
    
    // Validate route
    const validation = validateRoute(routeData, testCase.expected);
    
    // Claude analysis (optional)
    const claudeAnalysis = await analyzeWithClaude(testCase.query, routeData);
    
    // Print results
    const stats = routeData.stats;
    console.log(`\n✓ Route generated successfully`);
    console.log(`  Route ID: ${routeData.routeId}`);
    console.log(`  Distance: ${stats.distanceMiles || stats.distance_miles} miles`);
    console.log(`  Elevation: ${stats.elevationGainFeet || stats.elevation_gain_feet} feet`);
    console.log(`  Turns: ${stats.numberOfTurns || stats.num_turns}`);
    console.log(`  Duration: ${stats.estimatedDurationMinutes || stats.duration_minutes} minutes`);
    
    if (validation.details.isLoop) {
      console.log(`  Is Loop: ${validation.details.isLoop.actual ? 'Yes' : 'No'}`);
    }
    
    console.log(`\nValidation Results:`);
    if (validation.passed) {
      console.log(`  ✅ PASSED - All criteria met`);
    } else {
      console.log(`  ❌ FAILED`);
      console.log(`  Issues:`);
      validation.failures.forEach(failure => {
        console.log(`    - ${failure}`);
      });
    }
    
    if (claudeAnalysis.analyzed !== false) {
      console.log(`\nClaude Analysis:`);
      console.log(`  Match: ${claudeAnalysis.matches_request ? 'Yes' : 'No'}`);
      console.log(`  Score: ${claudeAnalysis.score}/100`);
      if (claudeAnalysis.issues && claudeAnalysis.issues.length > 0) {
        console.log(`  Issues: ${claudeAnalysis.issues.join(', ')}`);
      }
    }
    
    return {
      testName: testCase.name,
      passed: validation.passed,
      details: validation.details,
      claudeAnalysis
    };
    
  } catch (error) {
    console.log(`\n❌ ERROR: ${error.message}`);
    return {
      testName: testCase.name,
      passed: false,
      error: error.message
    };
  }
}

// Run all tests
async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('ROUTE RUNNER EVALUATION SYSTEM');
  console.log('='.repeat(60));
  console.log(`Worker URL: ${WORKER_URL}`);
  console.log(`Test Cases: ${TEST_CASES.length}`);
  
  const results = [];
  
  for (const testCase of TEST_CASES) {
    const result = await runTest(testCase);
    results.push(result);
    
    // Wait a bit between tests to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`Total Tests: ${results.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`);
  
  // Detailed failures
  if (failed > 0) {
    console.log(`\nFailed Tests:`);
    results.filter(r => !r.passed).forEach(result => {
      console.log(`  - ${result.testName}`);
      if (result.error) {
        console.log(`    Error: ${result.error}`);
      }
    });
  }
  
  return results;
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Route Runner Evaluation System

Usage:
  node eval-system.js [options]

Options:
  --help, -h          Show this help message
  --url <url>         Set worker URL (default: http://localhost:8787)
  --test <name>       Run specific test by name

Environment Variables:
  WORKER_URL          Worker endpoint URL
  ANTHROPIC_API_KEY   Anthropic API key for Claude analysis

Examples:
  # Run all tests against local worker
  node eval-system.js

  # Run against production
  WORKER_URL=https://your-worker.workers.dev node eval-system.js

  # Run specific test
  node eval-system.js --test "Simple 5 mile loop"
    `);
    process.exit(0);
  }
  
  // Check for specific test
  const testIndex = args.indexOf('--test');
  if (testIndex >= 0 && args[testIndex + 1]) {
    const testName = args[testIndex + 1];
    const testCase = TEST_CASES.find(t => t.name === testName);
    
    if (!testCase) {
      console.error(`❌ Test "${testName}" not found`);
      console.log(`Available tests: ${TEST_CASES.map(t => t.name).join(', ')}`);
      process.exit(1);
    }
    
    runTest(testCase).then(() => process.exit(0));
  } else {
    // Run all tests
    runAllTests().then(results => {
      const failed = results.filter(r => !r.passed).length;
      process.exit(failed > 0 ? 1 : 0);
    });
  }
}

module.exports = { runAllTests, runTest, validateRoute };
