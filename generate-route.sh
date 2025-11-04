#!/bin/bash

# Simple Route Generator - Edit the variables below to customize your route
# Usage: ./generate-route.sh

# ============================================================================
# EDIT THESE VARIABLES
# ============================================================================

# Your route query (describe what you want)
QUERY="10 mile one way route that goes around green lake and continues on the burke gilman trail and ends at Laurelhurst elemtnary school"

# Starting location (latitude and longitude)
LAT=47.665110896471
LNG=-122.3280966245202

# API endpoint (production by default)
API_URL="https://route-runner-api.route-runner.workers.dev"

# Filename will be generated from the AI-generated route name
# Placeholder for now, will be set after API call
OUTPUT_FILE=""

# ============================================================================
# SCRIPT START - Don't edit below this line unless you know what you're doing
# ============================================================================

set -e  # Exit on error

echo "🏃 Generating route..."
echo "   Query: $QUERY"
echo "   Location: ($LAT, $LNG)"
echo ""

# Step 1: Generate route
echo "📍 Creating route..."
RESPONSE=$(curl -s -X POST "$API_URL/api/generate-route" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$QUERY\", \"location\": {\"lat\": $LAT, \"lng\": $LNG}}")

# Check for errors
if echo "$RESPONSE" | grep -q '"error"'; then
    echo "❌ Error: $(echo $RESPONSE | grep -o '"error":"[^"]*"' | sed 's/"error":"\([^"]*\)"/\1/')"
    exit 1
fi

# Extract IDs
SESSION_ID=$(echo $RESPONSE | grep -o '"sessionId":"[^"]*"' | sed 's/"sessionId":"\([^"]*\)"/\1/')
ROUTE_ID=$(echo $RESPONSE | grep -o '"routeId":"[^"]*"' | sed 's/"routeId":"\([^"]*\)"/\1/')

if [ -z "$SESSION_ID" ] || [ -z "$ROUTE_ID" ]; then
    echo "❌ Failed to generate route"
    echo "Response: $RESPONSE"
    exit 1
fi

# Extract route name and stats
ROUTE_NAME=$(echo $RESPONSE | grep -o '"name":"[^"]*"' | sed 's/"name":"\([^"]*\)"/\1/')
DISTANCE=$(echo $RESPONSE | grep -o '"distance_miles":[0-9.]*' | sed 's/"distance_miles":\([0-9.]*\)/\1/')
ELEVATION=$(echo $RESPONSE | grep -o '"elevation_gain_feet":[0-9]*' | sed 's/"elevation_gain_feet":\([0-9]*\)/\1/')
TURNS=$(echo $RESPONSE | grep -o '"num_turns":[0-9]*' | sed 's/"num_turns":\([0-9]*\)/\1/')
DURATION=$(echo $RESPONSE | grep -o '"duration_minutes":[0-9]*' | sed 's/"duration_minutes":\([0-9]*\)/\1/')

# Create filename from route name
FILENAME=$(echo "$ROUTE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g')
OUTPUT_FILE="$HOME/${FILENAME}.gpx"

echo "✅ Route created successfully!"
echo ""
echo "🏃 Route Name: $ROUTE_NAME"
echo ""
echo "📊 Route Stats:"
echo "   Distance: $DISTANCE miles"
echo "   Elevation gain: $ELEVATION feet"
echo "   Number of turns: $TURNS"
echo "   Estimated duration: $DURATION minutes"
echo ""

# Step 2: Download GPX
echo "💾 Downloading GPX file..."
curl -s -X GET "$API_URL/api/route/$SESSION_ID/$ROUTE_ID/gpx" -o "$OUTPUT_FILE"

if [ -f "$OUTPUT_FILE" ]; then
    FILE_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    echo "✅ GPX file saved: $OUTPUT_FILE ($FILE_SIZE bytes)"
    echo ""
    echo "🎉 Done! You can now import $OUTPUT_FILE into your GPS device or running app."
    echo ""
    echo "🔗 View full route details:"
    echo "   $API_URL/api/route/$SESSION_ID/$ROUTE_ID"
else
    echo "❌ Failed to download GPX file"
    exit 1
fi
