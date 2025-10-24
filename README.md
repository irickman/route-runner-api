# Route Runner API

A Cloudflare Workers API that generates custom running routes based on natural language queries using AI and real-world mapping data.

## Features

- **Natural Language Route Generation**: Describe your ideal run in plain English (e.g., "5 mile loop from Space Needle")
- **Real-World Routes**: Routes use actual roads and paths via Mapbox routing
- **Detailed Statistics**: Get distance, elevation gain, number of turns, and estimated duration
- **GPX Export**: Download routes as GPX files for use in GPS devices and running apps
- **Session Management**: Store and retrieve previously generated routes

## API Endpoints

### POST /api/generate-route

Generate a new running route based on a natural language query.

**Request:**
```json
{
  "query": "5 mile loop from Space Needle",
  "location": {
    "lat": 47.6205,
    "lng": -122.3493
  },
  "sessionId": "optional-session-id"
}
```

**Response:**
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "routeId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "geometry": {
    "type": "LineString",
    "coordinates": [[-122.3493, 47.6205], ...]
  },
  "stats": {
    "distance_miles": 5.12,
    "elevation_gain_feet": 245,
    "num_turns": 18,
    "duration_minutes": 62
  }
}
```

### GET /api/route/:sessionId/:routeId

Retrieve a previously generated route with full details including elevation data.

### GET /api/route/:sessionId/:routeId/gpx

Download a route as a GPX file for GPS devices and running apps.

## Technology Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **AI**: Anthropic Claude API
- **Mapping**: Mapbox Directions & Elevation APIs
- **Storage**: Cloudflare KV (24-hour route retention)

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test

# Deploy to production
npm run deploy
```

## Setup

This API requires:
- Cloudflare account with Workers enabled
- Anthropic API key
- Mapbox access token

See the deployment documentation for detailed setup instructions.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
