import { Location } from '../../types';

export enum ModelTier {
  FAST = 'fast',       // Gemini Flash, Claude Haiku
  BALANCED = 'balanced', // GPT-4o Mini, Claude Haiku (Enhanced)
  INTELLIGENT = 'intelligent' // GPT-4o, Claude 3.5 Sonnet, Gemini Pro
}

export interface ParsedIntent {
  start: Location;
  waypoints?: Location[];
  end: Location;
  distance_miles?: number;
  max_elevation_gain_feet?: number;
  preferences?: string[];
}

export interface AIProvider {
  parseIntent(
    query: string, 
    userLocation: Location, 
    locationContext?: string
  ): Promise<ParsedIntent>;

  generateName(
    query: string, 
    stats: { distance_miles: number; elevation_gain_feet: number }
  ): Promise<string>;
}
