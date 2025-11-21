export interface Location {
  lat: number;
  lng: number;
}

export interface Env {
  SESSIONS: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MAPBOX_TOKEN: string;
}
