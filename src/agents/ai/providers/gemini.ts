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

const GEMINI_SYSTEM_PROMPT = `You are a running route planner. You help parse natural language queries into structured route data.

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

export class GeminiProvider implements AIProvider {
    constructor(private apiKey: string, private model: string = 'gemini-1.5-flash') { }

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
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

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
                generationConfig: {
                    responseMimeType: "application/json"
                }
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

        const content = data.candidates[0].content.parts[0].text;

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
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

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
