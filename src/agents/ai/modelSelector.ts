import { Env } from '../../types';
import { AIProvider, ModelTier } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
import { GeminiProvider } from './providers/gemini';

export class ModelSelector {
    constructor(private env: Env) { }

    private determineTier(query: string): ModelTier {
        const lowerQuery = query.toLowerCase();
        const wordCount = query.split(/\s+/).length;

        // Tier 3: High Intelligence (Complex constraints, ambiguous queries)
        // Triggers: "scenic", "avoid hills", "flat", specific complex instructions, long queries
        if (
            lowerQuery.includes('scenic') ||
            lowerQuery.includes('avoid') ||
            lowerQuery.includes('flat') ||
            lowerQuery.includes('hilly') ||
            lowerQuery.includes('challenging') ||
            lowerQuery.includes('view') ||
            lowerQuery.includes('waterfront') ||
            wordCount > 20
        ) {
            return ModelTier.INTELLIGENT;
        }

        // Tier 2: Balanced (Specific landmarks, simple constraints)
        // Triggers: Mentions of specific places (capitalized words often indicate this), medium length
        if (
            /[A-Z]/.test(query) || // Contains capitalized words (potential landmarks)
            wordCount > 10
        ) {
            return ModelTier.BALANCED;
        }

        // Tier 1: Fast/Cheap (Simple "X mile loop" requests)
        return ModelTier.FAST;
    }

    getProvider(query: string): AIProvider {
        const tier = this.determineTier(query);
        console.log(`🧠 Query complexity analysis: "${query}" -> Tier: ${tier}`);

        switch (tier) {
            case ModelTier.INTELLIGENT:
                // Prefer GPT-4o or Claude 3.5 Sonnet
                if (this.env.OPENAI_API_KEY) {
                    console.log('🚀 Using OpenAI (GPT-4o)');
                    return new OpenAIProvider(this.env.OPENAI_API_KEY, 'gpt-4o');
                }
                if (this.env.ANTHROPIC_API_KEY) {
                    console.log('🚀 Using Anthropic (Claude 3.5 Sonnet)');
                    return new AnthropicProvider(this.env.ANTHROPIC_API_KEY, 'claude-3-sonnet-20240229');
                }
                // Fallback to Gemini Pro
                if (this.env.GEMINI_API_KEY) {
                    console.log('🚀 Using Gemini (Pro)');
                    return new GeminiProvider(this.env.GEMINI_API_KEY, 'gemini-1.5-pro');
                }
                break;

            case ModelTier.BALANCED:
                // Prefer GPT-4o Mini or Claude Haiku
                if (this.env.OPENAI_API_KEY) {
                    console.log('🚀 Using OpenAI (GPT-4o Mini)');
                    return new OpenAIProvider(this.env.OPENAI_API_KEY, 'gpt-4o-mini');
                }
                if (this.env.ANTHROPIC_API_KEY) {
                    console.log('🚀 Using Anthropic (Claude Haiku)');
                    return new AnthropicProvider(this.env.ANTHROPIC_API_KEY, 'claude-haiku-4-5-20251001');
                }
                break;

            case ModelTier.FAST:
                // Prefer Gemini Flash or Claude Haiku
                if (this.env.GEMINI_API_KEY) {
                    console.log('🚀 Using Gemini (Flash)');
                    return new GeminiProvider(this.env.GEMINI_API_KEY, 'gemini-1.5-flash');
                }
                if (this.env.ANTHROPIC_API_KEY) {
                    console.log('🚀 Using Anthropic (Claude Haiku)');
                    return new AnthropicProvider(this.env.ANTHROPIC_API_KEY, 'claude-haiku-4-5-20251001');
                }
                break;
        }

        // Ultimate fallback: whatever key we have
        if (this.env.ANTHROPIC_API_KEY) {
            return new AnthropicProvider(this.env.ANTHROPIC_API_KEY);
        }
        if (this.env.OPENAI_API_KEY) {
            return new OpenAIProvider(this.env.OPENAI_API_KEY);
        }
        if (this.env.GEMINI_API_KEY) {
            return new GeminiProvider(this.env.GEMINI_API_KEY);
        }

        throw new Error('No AI API keys configured!');
    }
}
