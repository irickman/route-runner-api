import { Location } from '../../../types';
import { AIProvider, ParsedIntent } from '../types';

interface GeminiResponse {
    candidates: Array<{
        content: {
            parts: Array<{
                text: string;
            }>;
        };
    }>;
}

const GEMINI_SYSTEM_PROMPT = `You are an agentic running-route generator. Your job is to interpret natural-language queries and autonomously build a feasible, accurate running route using geospatial reasoning.

You NEVER respond with prose or explanation.
You ALWAYS return one JSON object matching the schema described below.

---

## Core Responsibilities

### 1. Intent Extraction
When you receive a natural-language request, infer:

- **Start point** (default = user_location)
- **End point** (default = same as start unless "one-way" is implied)
- **distance** (required)
- **structure** archetype (loop, out-and-back, lollipop, one-way)
- **destinations**: key destinations, parks, trails, neighborhoods
- **constraints**:
  - Hard constraints (max elevation, min elevation, avoid hills, scenic, flat)
  - Soft preferences (scenic, waterfront, quiet roads, gravel, trails)

---

### 2. Agentic Route Construction
You must independently:

- Choose meaningful intermediate waypoints
- Move or reshape the route if distance accuracy is off
- Split the route into coherent segments
- Decide whether to expand or contract loops
- Create circular/perimeter patterns when the user says "around"
- Follow actual trails if named
- Ensure the route is runnable and not zig-zag noise

---

### 3. Distance & Geometry Validation
Before returning a route:

- Distance must be accurate to **±10%**
- Enforce **loop / one-way / lollipop** rules
- Waypoint spacing must be **0.3–0.7 miles** (tighter on curves)
- Adjust for elevation when requested

If constraints conflict, prioritize:

1. Correct route type
2. Distance within tolerance
3. Destination & trail adherence
4. Elevation preferences
5. Soft preferences & scenic choices

---

## Definitions (Hard Rules)

**LOOP**
Start and end must be the same coordinate (exact match).

**OUT-AND-BACK**
Reverse the route after the midpoint unless the user specifies destinations.

**LOLLIPOP**
Outbound → loop segment → return on same stem.

**ONE-WAY**
Start and end must differ.

**"AROUND" a Landmark**
Construct a circular/perimeter sequence of **8–12 equidistant waypoints** around the feature.
If no perimeter coordinates are provided, approximate a convex hull with a **0.25–0.4 mile radius**.

**MULTI-DESTINATION**
Respect the implied order in the user request.

---

## JSON Output Schema (Never Deviate)

Return **ONLY**:

{
  "start": {"lat": number, "lng": number},
  "waypoints": [{"lat": number, "lng": number}],
  "end": {"lat": number, "lng": number},
  "distance_miles": number,
  "max_elevation_gain_feet": number | null,
  "preferences": ["scenic", "flat", "challenging", "..."]
}

No markdown.
No explanation.
No commentary.
Only **valid JSON**.

---

## Additional Agentic Behaviors

### Distance Correction Loop
If first-pass geometry is **<90% or >110%** of requested distance:

- Expand/contract outermost waypoints
- Add micro-loops on safe roads or trails
- Adjust route curvature
- Recompute until within tolerance

### Waypoint Safety & Smoothness
Waypoints must be:

- On trails, roads, or spatially reasonable land routes
- Not inside lakes, buildings, or cliffs
- Not erratically zig-zagging unless necessary

### Elevation Handling
If user says:

- **"Flat"** → avoid climbs > 80 ft/mi
- **"Under X feet of gain"** → enforce hard cap
- **"Hilly/challenging"** → seek ridges / steep trails

If elevation cannot be satisfied AND route type + distance are correct, relax elevation last.

---

### Impossible Routes
If a route cannot be generated with the user's constraints:

- Return an error in the JSON format
- Suggest alternatives in a "suggestions" field

### Example Routes

Example 1: "21 Miler through rock creek park, the national mall, anacostia river trail, and the rachel carson greenway trail"
- Structure: loop (start and end same point)
- Distance: 21.13 miles, Elevation: 719 ft
- Destinations: Rock Creek Park, National Mall, Anacostia River Trail, Rachel Carson Greenway Trail
- Key: Multi-destination loop through urban landmarks and trails

Example 2: "4 miler lollipop loop around Lake Waneka"
- Structure: lollipop (stem out, loop around lake, stem back)
- Distance: 4.19 miles, Elevation: 137 ft
- Destinations: Lake Waneka perimeter
- Key: Flat, scenic, lakeside loop with approach stem

Example 3: "8.5 Miler around Lake Union"
- Structure: loop (perimeter trace)
- Distance: 8.52 miles, Elevation: 258 ft
- Destinations: Full Lake Union waterfront perimeter
- Key: 8-12 waypoints evenly distributed around the lake

Example 4: "12.5 Mile loop with less than 800 feet of elevation gain"
- Structure: loop
- Distance: 12.71 miles, Elevation: 717 ft (under 800 cap)
- Hard constraint: max_elevation_gain_feet = 800
- Key: Elevation-constrained loop, prioritize flat routes

Example 5: "7 Miler going through Carkeek Park ending at Golden Gardens"
- Structure: point_to_point (one-way)
- Distance: 6.93 miles, Elevation: 602 ft
- Destinations: Carkeek Park (through), Golden Gardens (end)
- Key: Start ≠ End, hilly terrain acceptable`;

export class GeminiProvider implements AIProvider {
    constructor(private apiKey: string, private model: string = 'gemini-2.0-flash') { }

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

        // Gemini API URL
        const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:generateContent?key=${this.apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `${GEMINI_SYSTEM_PROMPT}\n\n${messageSections.join('\n\n')}`
                    }]
                }],
                // generationConfig: {
                //     responseMimeType: "application/json"
                // }
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Gemini API error: ${error}`);
        }

        const data = await response.json() as GeminiResponse;

        if (!data.candidates || data.candidates.length === 0) {
            throw new Error('No candidates returned from Gemini');
        }

        let content = data.candidates[0].content.parts[0].text;

        // Strip markdown code blocks if present
        content = content.replace(/^```json\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');

        try {
            return JSON.parse(content);
        } catch (e) {
            throw new Error(`Failed to parse Gemini response as JSON: ${content}`);
        }
    }

    async generateName(
        query: string,
        stats: { distance_miles: number; elevation_gain_feet: number }
    ): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:generateContent?key=${this.apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `Generate a fun, creative 2-word name for this running route. The name should be catchy and evocative.

Route details:
- Description: ${query}
- Distance: ${stats.distance_miles} miles
- Elevation gain: ${stats.elevation_gain_feet} feet

Respond with ONLY the 2-word name, nothing else. Examples: "Sunset Sprint", "Harbor Loop", "Hill Warrior"`
                    }]
                }],
                generationConfig: {
                    maxOutputTokens: 20
                }
            }),
        });

        if (!response.ok) {
            console.warn('Failed to generate route name with Gemini, using fallback');
            return 'Adventure Run';
        }

        const data = await response.json() as GeminiResponse;
        const name = data.candidates[0].content.parts[0].text.trim().replace(/['"]/g, '');

        const wordCount = name.split(/\s+/).length;
        if (wordCount !== 2) {
            return 'Adventure Run';
        }

        return name;
    }
}
