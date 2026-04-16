import Anthropic from '@anthropic-ai/sdk';
import type { TaskPriority, GenerateTaskMetadataResponse } from '@fastowl/shared';

// Initialize Anthropic client (uses ANTHROPIC_API_KEY env var)
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Generate task title and description from a prompt using Claude Haiku
 */
export async function generateTaskMetadata(prompt: string): Promise<GenerateTaskMetadataResponse> {
  const anthropic = getClient();

  const systemPrompt = `You are a task metadata generator. Given a user's task prompt, generate:
1. A concise title (max 60 characters)
2. A brief description (1-2 sentences)
3. A suggested priority (low, medium, high, or urgent)

Respond in JSON format only:
{"title": "...", "description": "...", "suggestedPriority": "..."}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Generate task metadata for this prompt:\n\n${prompt}`,
        },
      ],
      system: systemPrompt,
    });

    // Extract text content
    const textContent = response.content.find(block => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON response
    const result = JSON.parse(textContent.text);

    // Validate and sanitize
    const title = String(result.title || 'New Task').slice(0, 60);
    const description = String(result.description || prompt).slice(0, 500);
    const suggestedPriority = validatePriority(result.suggestedPriority);

    return { title, description, suggestedPriority };
  } catch (error) {
    console.error('Failed to generate task metadata:', error);
    // Fallback to basic extraction
    return {
      title: prompt.slice(0, 60).trim() || 'New Task',
      description: prompt.slice(0, 200).trim(),
      suggestedPriority: 'medium',
    };
  }
}

function validatePriority(priority: unknown): TaskPriority {
  if (priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'urgent') {
    return priority;
  }
  return 'medium';
}

/**
 * Check if AI service is configured
 */
export function isConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
