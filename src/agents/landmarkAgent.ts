/* Location agent powered by Mapbox Geocoding.
 * Extracts landmarks and destinations referenced in the user's query,
 * resolves them to precise coordinates, and emits perimeter hints when available.
 */

import { Location } from '../types';

export type LocationPurpose = 'perimeter' | 'destination' | 'landmark' | 'unknown';

type PurposePriority = Record<LocationPurpose, number>;

const MILES_RADIUS = 25;
const EARTH_RADIUS_MILES = 3958.8;
const MAX_PERIMETER_POINTS = 20;
const MAPBOX_TYPES = 'poi,landmark,place,neighborhood,locality,region,park,address,street';
const PURPOSE_PRIORITY: PurposePriority = {
  perimeter: 3,
  destination: 2,
  landmark: 1,
  unknown: 0,
};

interface MapboxGeometry {
  type: 'Point' | 'Polygon' | 'MultiPolygon';
  coordinates: any;
}

interface MapboxFeature {
  id: string;
  text: string;
  place_name: string;
  place_type: string[];
  center: [number, number];
  geometry: MapboxGeometry;
  bbox?: [number, number, number, number];
  relevance?: number;
  properties?: Record<string, any>;
}

interface MapboxGeocodingResponse {
  features: MapboxFeature[];
}

export interface MentionSummary {
  phrase: string;
  purpose: LocationPurpose;
}

export interface ResolvedLocation {
  name: string;
  type: string;
  coordinates: Location;
  distance_miles: number;
  perimeter_points?: Location[];
  source: 'mapbox';
  confidence: number;
  purpose: LocationPurpose;
  mention: string;
  notes?: string;
}

export interface LocationsResult {
  mentions: MentionSummary[];
  locations: ResolvedLocation[];
}

function purposePriority(purpose: LocationPurpose): number {
  return PURPOSE_PRIORITY[purpose] ?? 0;
}

function haversineDistanceMiles(a: Location, b: Location): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const aCalc = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(aCalc), Math.sqrt(1 - aCalc));
  return EARTH_RADIUS_MILES * c;
}

function cleanCapturedPhrase(phrase: string): string {
  return phrase
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/[.,!?;:]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function registerMention(
  mentionMap: Map<string, MentionSummary>,
  rawPhrase: string,
  purpose: LocationPurpose
) {
  const cleaned = cleanCapturedPhrase(rawPhrase);
  if (!cleaned) {
    return;
  }

  const key = cleaned.toLowerCase();
  const existing = mentionMap.get(key);

  if (!existing || purposePriority(purpose) > purposePriority(existing.purpose)) {
    mentionMap.set(key, {
      phrase: cleaned,
      purpose,
    });
  }
}

export function extractLocationMentions(query: string): MentionSummary[] {
  const mentionMap = new Map<string, MentionSummary>();

  const aroundRegex = /\b(?:run|jog|walk|loop|circle|go|head|route)\s+around\s+([A-Za-z0-9'&\- ]{3,})/gi;
  let match: RegExpExecArray | null;
  while ((match = aroundRegex.exec(query)) !== null) {
    registerMention(mentionMap, match[1], 'perimeter');
  }

  const destinationRegex = /\b(?:to|toward|towards|into|onto|arrive at|stop at|end(?:ing)? at|finish(?:ing)? at)\s+(?:the\s+)?([A-Za-z0-9'&\- ]{3,})/gi;
  while ((match = destinationRegex.exec(query)) !== null) {
    registerMention(mentionMap, match[1], 'destination');
  }

  const startRegex = /\bstart(?:ing)?(?:\s+from|\s+at)?\s+(?:the\s+)?([A-Za-z0-9'&\- ]{3,})/gi;
  while ((match = startRegex.exec(query)) !== null) {
    registerMention(mentionMap, match[1], 'destination');
  }

  const viaRegex = /\bvia\s+(?:the\s+)?([A-Za-z0-9'&\- ]{3,})/gi;
  while ((match = viaRegex.exec(query)) !== null) {
    registerMention(mentionMap, match[1], 'landmark');
  }

  const capitalizedPattern = /([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*)+)/g;
  while ((match = capitalizedPattern.exec(query)) !== null) {
    registerMention(mentionMap, match[1], 'landmark');
  }

  return Array.from(mentionMap.values());
}

function createPerimeterFromBBox(bbox: [number, number, number, number]): Location[] {
  const [west, south, east, north] = bbox;
  return [
    { lat: north, lng: west },
    { lat: north, lng: east },
    { lat: south, lng: east },
    { lat: south, lng: west },
  ];
}

function sampleRing(coordinates: [number, number][], maxPoints: number): Location[] {
  if (coordinates.length === 0) {
    return [];
  }

  const step = Math.max(1, Math.floor(coordinates.length / maxPoints));
  const sampled: Location[] = [];

  for (let i = 0; i < coordinates.length; i += step) {
    const [lng, lat] = coordinates[i];
    sampled.push({ lat, lng });
  }

  if (sampled.length === 0) {
    const [lng, lat] = coordinates[0];
    sampled.push({ lat, lng });
  }

  return sampled;
}

function extractPerimeterPoints(feature: MapboxFeature): { points?: Location[]; notes?: string } {
  if (feature.geometry.type === 'Polygon' && Array.isArray(feature.geometry.coordinates)) {
    const outerRing = feature.geometry.coordinates[0] as [number, number][];
    if (outerRing) {
      const points = sampleRing(outerRing, MAX_PERIMETER_POINTS);
      return { points, notes: `Perimeter from polygon (${points.length} pts)` };
    }
  }

  if (feature.geometry.type === 'MultiPolygon' && Array.isArray(feature.geometry.coordinates)) {
    const firstPolygon = feature.geometry.coordinates[0] as [number, number][];
    if (firstPolygon) {
      const points = sampleRing(firstPolygon, MAX_PERIMETER_POINTS);
      return { points, notes: `Perimeter from multipolygon (${points.length} pts)` };
    }
  }

  if (feature.bbox) {
    const points = createPerimeterFromBBox(feature.bbox);
    return { points, notes: 'Perimeter from bounding box corners' };
  }

  return {};
}

function resolveType(feature: MapboxFeature): string {
  if (feature.place_type && feature.place_type.length > 0) {
    return feature.place_type[0];
  }

  if (feature.properties?.category) {
    return feature.properties.category;
  }

  return 'landmark';
}

async function geocodeMention(
  mention: MentionSummary,
  userLocation: Location,
  mapboxToken: string
): Promise<ResolvedLocation[]> {
  const encodedQuery = encodeURIComponent(mention.phrase);
  const params = new URLSearchParams({
    access_token: mapboxToken,
    proximity: `${userLocation.lng},${userLocation.lat}`,
    limit: '5',
    types: MAPBOX_TYPES,
  });

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedQuery}.json?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    console.warn(`Location geocoding failed for "${mention.phrase}": ${body}`);
    return [];
  }

  const data: MapboxGeocodingResponse = await response.json();
  if (!data.features || data.features.length === 0) {
    return [];
  }

  const withinRadius: ResolvedLocation[] = [];
  let fallback: ResolvedLocation | undefined;

  for (const feature of data.features) {
    const [lng, lat] = feature.center;
    const coordinates = { lat, lng };
    const distance = haversineDistanceMiles(userLocation, coordinates);

    const { points: perimeterPoints, notes: perimeterNotes } = extractPerimeterPoints(feature);
    const noteParts: string[] = [];
    if (perimeterNotes) {
      noteParts.push(perimeterNotes);
    }

    const resolved: ResolvedLocation = {
      name: feature.text || feature.place_name || mention.phrase,
      type: resolveType(feature),
      coordinates,
      distance_miles: Math.round(distance * 10) / 10,
      perimeter_points: perimeterPoints,
      source: 'mapbox',
      confidence: feature.relevance ?? 0,
      purpose: mention.purpose,
      mention: mention.phrase,
      notes: undefined,
    };

    if (distance <= MILES_RADIUS) {
      resolved.notes = noteParts.length ? noteParts.join('; ') : undefined;
      withinRadius.push(resolved);
    } else if (!fallback) {
      if (noteParts.length) {
        noteParts.unshift(`outside ${MILES_RADIUS}mi radius`);
      } else {
        noteParts.push(`outside ${MILES_RADIUS}mi radius`);
      }
      fallback = {
        ...resolved,
        notes: noteParts.join('; '),
      };
    }
  }

  if (withinRadius.length > 0) {
    return withinRadius;
  }

  return fallback ? [fallback] : [];
}

export async function resolveLocations(
  query: string,
  userLocation: Location,
  mapboxToken: string
): Promise<LocationsResult> {
  if (!mapboxToken) {
    console.warn('Mapbox token missing; skipping location resolution');
    return { mentions: [], locations: [] };
  }

  const mentions = extractLocationMentions(query);
  if (mentions.length === 0) {
    return { mentions: [], locations: [] };
  }

  const locationMap = new Map<string, ResolvedLocation>();

  const geocodingPromises = mentions.map(async (mention) => {
    try {
      const candidates = await geocodeMention(mention, userLocation, mapboxToken);
      return { mention, candidates };
    } catch (error) {
      console.warn(`Error resolving location "${mention.phrase}":`, error);
      return { mention, candidates: [] };
    }
  });

  const results = await Promise.all(geocodingPromises);

  for (const { candidates } of results) {
    for (const candidate of candidates) {
      const key = `${candidate.name.toLowerCase()}_${candidate.coordinates.lat.toFixed(4)}_${candidate.coordinates.lng.toFixed(4)}`;
      const existing = locationMap.get(key);

      if (!existing || purposePriority(candidate.purpose) > purposePriority(existing.purpose)) {
        locationMap.set(key, candidate);
      } else if (existing && !existing.perimeter_points && candidate.perimeter_points) {
        locationMap.set(key, {
          ...existing,
          perimeter_points: candidate.perimeter_points,
          notes: candidate.notes ?? existing.notes,
        });
      }
    }
  }

  const locations = Array.from(locationMap.values()).sort((a, b) => a.distance_miles - b.distance_miles);
  return { mentions, locations };
}

export function formatLocationsForPrompt(locations: ResolvedLocation[]): string {
  if (!locations.length) {
    return '';
  }

  const lines = locations.map(location => {
    const base = `${location.name} — ${location.type} — ${location.coordinates.lat.toFixed(4)}, ${location.coordinates.lng.toFixed(4)}`;
    const extras: string[] = [
      `purpose=${location.purpose}`,
      `distance=${location.distance_miles.toFixed(1)}mi`,
      `confidence=${location.confidence.toFixed(2)}`,
    ];

    if (location.perimeter_points?.length) {
      extras.push(`perimeter_points=${location.perimeter_points.length}`);
    } else {
      extras.push('perimeter=unknown');
    }

    if (location.notes) {
      extras.push(location.notes);
    }

    return `${base} — ${extras.join(', ')}`;
  });

  return `Nearby locations:\n${lines.join('\n')}`;
}
