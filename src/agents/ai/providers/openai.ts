import { Location } from '../../../types';
import { AIProvider, ParsedIntent } from '../types';

interface OpenAIResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
}

// Reusing the same system prompt logic for consistency, but could be tuned for GPT models
const OPENAI_SYSTEM_PROMPT = `You are a running route planner. You help parse natural language queries into structured route data.

You will receive:
- The user's location.
- Optionally, a "Nearby locations" section listing places the Location Agent found within 25 miles of the user.
- Purpose describes how the user referenced the place.

CRITICAL RULES:
1. DISTANCE ACCURACY: Total geodesic length MUST be within ±10% of requested distance.
2. ONE-WAY vs LOOPS: "Loop" = start==end. "One way" = start!=end.
3. "AROUND" A LANDMARK: Trace the PERIMETER. Use provided perimeter_points or create 8-12 waypoints circling the feature.
4. MULTI-SEGMENT: Ensure adequate waypoints for each segment.
5. WAYPOINT SPACING: 0.4-0.7 miles apart for straight segments, closer for loops.
6. TRAIL NAMES: Follow the trail if specified.

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
- For loops, start and end must be the same.
- Respond with ONLY the JSON object—no markdown or commentary.`;

export class OpenAIProvider implements AIProvider {
    constructor(private apiKey: string, private model: string = 'gpt-4o-mini') { }

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

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: OPENAI_SYSTEM_PROMPT,
                    },
                    {
                        role: 'user',
                        content: messageSections.join('\n\n'),
                    },
                ],
                temperature: 0.2, // Lower temperature for more deterministic JSON
                response_format: { type: "json_object" } // Force JSON output
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${error}`);
        }

        const data = await response.json() as OpenAIResponse;
        const content = data.choices[0].message.content;

        try {
            return JSON.parse(content);
        } catch (e) {
            throw new Error(`Failed to parse OpenAI response as JSON: ${content}`);
        }
    }

    async generateName(
        query: string,
        stats: { distance_miles: number; elevation_gain_feet: number }
    ): Promise<string> {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
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
                max_tokens: 20,
            }),
        });

        if (!response.ok) {
            console.warn('Failed to generate route name with OpenAI, using fallback');
            return 'Adventure Run';
        }

        const data = await response.json() as OpenAIResponse;
        const name = data.choices[0].message.content.trim().replace(/['"]/g, '');

        const wordCount = name.split(/\s+/).length;
        if (wordCount !== 2) {
            return 'Adventure Run';
        }

        return name;
    }
}
