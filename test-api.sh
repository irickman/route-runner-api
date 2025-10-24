#!/bin/bash

# Route Runner API - Complete Integration Test
# Tests all three endpoints in sequence

set -e  # Exit on error

# Configuration - can be overridden with environment variables
API_URL="${API_URL:-http://localhost:8787}"
QUERY="${QUERY:-5 mile loop from Space Needle}"
LAT="${LAT:-47.6205}"
LNG="${LNG:--122.3493}"

echo "=================================="
echo "Route Runner API Integration Test"
echo "=================================="
echo "API URL: $API_URL"
echo ""

# Test 1: Generate Route
echo "1. Testing POST /api/generate-route"
echo "   Query: \"$QUERY\""
echo "   Location: ($LAT, $LNG)"
echo ""

RESPONSE=$(curl -s -X POST "$API_URL/api/generate-route" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$QUERY\", \"location\": {\"lat\": $LAT, \"lng\": $LNG}}")

echo "   Response (first 200 chars):"
echo "   $(echo $RESPONSE | head -c 200)..."
echo ""

# Extract sessionId and routeId using grep and sed
SESSION_ID=$(echo $RESPONSE | grep -o '"sessionId":"[^"]*"' | sed 's/"sessionId":"\([^"]*\)"/\1/')
ROUTE_ID=$(echo $RESPONSE | grep -o '"routeId":"[^"]*"' | sed 's/"routeId":"\([^"]*\)"/\1/')

if [ -z "$SESSION_ID" ] || [ -z "$ROUTE_ID" ]; then
    echo "   ❌ ERROR: Failed to extract sessionId or routeId"
    echo "   Full response: $RESPONSE"
    exit 1
fi

echo "   ✅ Route generated successfully!"
echo "   Session ID: $SESSION_ID"
echo "   Route ID: $ROUTE_ID"
echo ""

# Test 2: Get Route Details
echo "2. Testing GET /api/route/:sessionId/:routeId"
echo ""

ROUTE_DETAILS=$(curl -s -X GET "$API_URL/api/route/$SESSION_ID/$ROUTE_ID")

echo "   Response (first 300 chars):"
echo "   $(echo $ROUTE_DETAILS | head -c 300)..."
echo ""

# Check if response contains expected fields
if echo "$ROUTE_DETAILS" | grep -q "originalQuery" && \
   echo "$ROUTE_DETAILS" | grep -q "elevation" && \
   echo "$ROUTE_DETAILS" | grep -q "createdAt"; then
    echo "   ✅ Route details retrieved successfully!"
else
    echo "   ❌ ERROR: Route details response missing expected fields"
    exit 1
fi
echo ""

# Test 3: Download GPX
echo "3. Testing GET /api/route/:sessionId/:routeId/gpx"
echo ""

GPX_FILE="test-route-$ROUTE_ID.gpx"
curl -s -X GET "$API_URL/api/route/$SESSION_ID/$ROUTE_ID/gpx" -o "$GPX_FILE"

if [ -f "$GPX_FILE" ]; then
    FILE_SIZE=$(wc -c < "$GPX_FILE" | tr -d ' ')
    echo "   GPX file downloaded: $GPX_FILE"
    echo "   File size: $FILE_SIZE bytes"
    echo ""
    echo "   First 10 lines of GPX:"
    head -10 "$GPX_FILE" | sed 's/^/   /'
    echo "   ..."
    echo ""

    # Verify GPX structure
    if grep -q '<?xml version="1.0"' "$GPX_FILE" && \
       grep -q '<gpx version="1.1"' "$GPX_FILE" && \
       grep -q '<trkpt lat=' "$GPX_FILE"; then
        echo "   ✅ GPX file is valid!"
    else
        echo "   ❌ ERROR: GPX file structure is invalid"
        exit 1
    fi
else
    echo "   ❌ ERROR: Failed to download GPX file"
    exit 1
fi

echo ""
echo "=================================="
echo "✅ All tests passed!"
echo "=================================="
echo ""
echo "Cleanup: Removing test GPX file..."
rm -f "$GPX_FILE"
echo "Done!"
