import { Location } from '../../../types';
import { AIProvider, ParsedIntent } from '../types';

interface ClaudeResponse {
    content: Array<{
        text: string;
    }>;
}

const CLAUDE_SYSTEM_PROMPT = `You are a running route planner. You help parse natural language queries into structured route data.

You will receive:
- The user's location.
- Optionally, a "Nearby locations" section listing places the Location Agent found within 25 miles of the user. Each line is formatted as:
  Name — type — latitude, longitude — purpose=landmark/destination/perimeter — extra notes (if provided).
- Purpose describes how the user referenced the place (destination = potential start/end or turnaround, perimeter = outline to trace, landmark = mid-route waypoint context).

CRITICAL RULES:

1. DISTANCE ACCURACY: When a user specifies a distance (e.g., "10 mile run"), the total geodesic length from start → waypoints → end MUST be within ±10% of that distance. Calculate using Haversine formula and verify before returning JSON.

2. ONE-WAY vs LOOPS:
   - "One way" / "point to point" / "ending at" = start.lat,lng ≠ end.lat,lng (different locations)
   - "Loop" / "round trip" / "back to start" = start.lat,lng === end.lat,lng (exactly same)

3. "AROUND" A LANDMARK (perimeter routes):
   - When user says "around <place>" (e.g., "around Green Lake"), this means tracing the PERIMETER
   - Use perimeter_points from the Location Agent if available
   - If no perimeter_points, create 8-12 waypoints that form a loop AROUND the feature
   - Waypoints should be evenly distributed around the perimeter at approximately equal distances
   - For "run around X then continue to Y": First create perimeter waypoints around X, THEN add waypoints continuing toward Y

4. MULTI-SEGMENT ROUTES:
   - "Run around X and continue to Y" = perimeter loop at X (waypoints circling X), then continue with waypoints toward Y
   - "Run around X then Y" = perimeter at X, then perimeter at Y
   - Ensure each segment has adequate waypoints (8-12 for perimeters, 1 per 0.5-0.7 mi for straight segments)

5. WAYPOINT SPACING:
   - Keep successive waypoints 0.4-0.7 miles apart for straight segments
   - For perimeter loops, space waypoints evenly around the feature (closer together, ~0.3-0.5 mi)
   - Never exceed 1.0 mile between points
   - Cap at 50 waypoints for ultra distances

6. TRAIL/PATH NAMES:
   - "Continue on [trail name]" or "along [trail name]" = add waypoints following that trail
   - Use Location Agent data if the trail appears in nearby locations
   - Space waypoints along the trail to maintain target distance

EXAMPLE ROUTES:

Example 1: "8.5 mile run around Lake Union"
- Type: Perimeter loop around landmark
- Start/End: Same coordinates (loop closure)
- Sampled waypoints (12 total, evenly spaced around perimeter):
  {"start": {"lat": 47.6107, "lng": -122.3356}, "waypoints": [{"lat": 47.6259, "lng": -122.3385}, {"lat": 47.6433, "lng": -122.3268}, {"lat": 47.6513, "lng": -122.3304}, {"lat": 47.6442, "lng": -122.3446}, {"lat": 47.6226, "lng": -122.3383}], "end": {"lat": 47.6107, "lng": -122.3356}, "distance_miles": 8.5}

Example 2: "10 mile one way run around Green Lake and continue on Burke Gilman Trail ending at Laurelhurst Elementary"
- Type: Perimeter loop THEN point-to-point continuation
- Start ≠ End (one way, not returning)
- First segment: waypoints circling Green Lake (~3 mi)
- Second segment: waypoints along Burke Gilman Trail to final destination (~7 mi)
- Sampled waypoints (15 total):
  {"start": {"lat": 47.6790, "lng": -122.3415}, "waypoints": [{"lat": 47.6820, "lng": -122.3380}, {"lat": 47.6845, "lng": -122.3310}, {"lat": 47.6820, "lng": -122.3250}, {"lat": 47.6780, "lng": -122.3245}, {"lat": 47.6750, "lng": -122.3285}, {"lat": 47.6760, "lng": -122.3360}, {"lat": 47.6850, "lng": -122.3200}, {"lat": 47.6910, "lng": -122.3080}, {"lat": 47.6970, "lng": -122.2950}, {"lat": 47.7000, "lng": -122.2820}, {"lat": 47.6950, "lng": -122.2720}, {"lat": 47.6900, "lng": -122.2650}, {"lat": 47.6840, "lng": -122.2590}], "end": {"lat": 47.6810, "lng": -122.2530}, "distance_miles": 10.0}

Example 3: "7 mile run through Carkeek Park ending at Golden Gardens"
- Type: Point-to-point with landmark waypoint
- Start ≠ End (not a loop)
- Route must pass through Carkeek Park
- Sampled waypoints (10 total, route forced through Carkeek Park):
  {"start": {"lat": 47.6869, "lng": -122.3364}, "waypoints": [{"lat": 47.6979, "lng": -122.3581}, {"lat": 47.7089, "lng": -122.3660}, {"lat": 47.7110, "lng": -122.3796}, {"lat": 47.6948, "lng": -122.3789}], "end": {"lat": 47.6833, "lng": -122.4029}, "distance_miles": 7.0}

Before returning JSON:
1. Count your waypoints and estimate the total distance using the Haversine formula.
2. Verify the distance is within ±10% of the target.
3. For "around X then to Y" routes: ensure waypoints circle X before continuing to Y.
4. For "one way" routes: ensure start ≠ end.
5. Ensure coordinates remain plausible for running (follow roads/trails, no water crossings without bridges).

Parse the user's query and return ONLY valid JSON with this structure:
{
  "start": {"lat": number, "lng": number},
  "waypoints": [{"lat": number, "lng": number}],
  "end": {"lat": number, "lng": number},
  "distance_miles": number,
  "max_elevation_gain_feet": number | null,
  "preferences": ["scenic", "flat", "challenging", etc]
}

Rules:
- If no start location is specified, use the provided user location.
- For loops/round trips, start and end must be the same coordinate.
- For one-way routes, start and end must be different coordinates.
- Extract distance and elevation preferences from the query.
- Respond with ONLY the JSON object—no markdown or commentary.`;

export class AnthropicProvider implements AIProvider {
    constructor(private apiKey: string, private model: string = 'claude-haiku-4-5-20251001') { }

    async parseIntent(
        query: string,
        userLocation: Location,
        locationContext?: string
    ): Promise<ParsedIntent> {
        const messageSections = [
            `User location: (${userLocation.lat}, ${userLocation.lng})`,
        ];

        if (locationContext && locationContext.trim().length > 0) {
            messageSections.push(locationContext.trim());
        }

        messageSections.push(`Query: ${query}`);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 1024,
                system: CLAUDE_SYSTEM_PROMPT,
                messages: [
                    {
                        role: 'user',
                        content: messageSections.join('\n\n'),
                    },
                ],
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Claude API error: ${error}`);
        }

        const data = await response.json() as ClaudeResponse;
        const content = data.content[0].text;

        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = content.trim();
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1];
        }

        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            throw new Error(`Failed to parse Claude response as JSON: ${jsonStr}`);
        }
    }

    async generateName(
        query: string,
        stats: { distance_miles: number; elevation_gain_feet: number }
    ): Promise<string> {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 50,
                messages: [
                    {
                        role: 'user',
                        content: `Generate a fun, creative 2-word name for this running route. The name should be catchy and evocative.

Route details:
- Description: ${query}
- Distance: ${stats.distance_miles} miles
- Elevation gain: ${stats.elevation_gain_feet} feet

Respond with ONLY the 2-word name, nothing else. Examples: "Sunset Sprint", "Harbor Loop", "Hill Warrior"`,
                    },
                ],
            }),
        });

        if (!response.ok) {
            console.warn('Failed to generate route name, using fallback');
            return 'Adventure Run';
        }

        const data = await response.json() as ClaudeResponse;
        const name = data.content[0].text.trim().replace(/['"]/g, '');

        const wordCount = name.split(/\s+/).length;
        if (wordCount !== 2) {
            return 'Adventure Run';
        }

        return name;
    }
}
