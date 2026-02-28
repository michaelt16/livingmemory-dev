import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { generateText } from '@/lib/nova';

interface ExtractedFacts {
  who: string[];
  what: string[];
  when: string[];
  where: string[];
  why: string[];
  summary: string;
  completeness: number;
}

const FACT_EXTRACTION_PROMPT = `You are analyzing a conversation between a user and an AI about a photograph. 
Extract structured facts from the conversation.

Return a JSON object with these fields:
{
  "who": ["list of people mentioned, e.g. 'Grandpa Bob', 'my sister Sarah'"],
  "what": ["list of activities/events, e.g. 'fishing trip', 'birthday party', 'first day of school'"],
  "when": ["time references, e.g. 'summer 2024', '1985', 'last Christmas', 'early morning'"],
  "where": ["locations mentioned, e.g. 'Lake Tahoe', 'grandma's house', 'the old farm'"],
  "why": ["significance/meaning, e.g. 'annual tradition', 'last time we saw him', 'her favorite place'"],
  "summary": "A clean 2-3 sentence summary of the photo's story, filtering out filler words and conversation artifacts. Write as if describing the memory, not the conversation."
}

Rules:
- Only extract facts actually mentioned in the conversation
- Use empty arrays [] for categories with no information
- For summary, write in third person narrative style, not "the user said..."
- Filter out filler like "um", "let me think", "I remember", "that's interesting"
- Be specific: prefer "Grandpa Bob" over "someone", "Lake Tahoe" over "a lake"

Return ONLY the JSON object, no other text.`;

function calculateCompleteness(facts: ExtractedFacts): number {
  const categories = ['who', 'what', 'when', 'where', 'why'] as const;
  let filled = 0;
  
  for (const cat of categories) {
    if (facts[cat] && facts[cat].length > 0) {
      filled++;
    }
  }
  
  return Math.round((filled / categories.length) * 100);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: photoId } = await params;
    
    if (!photoId) {
      return NextResponse.json({ error: 'Photo ID is required' }, { status: 400 });
    }

    const supabase = createServerClient();
    
    let body: { messages?: Array<{ role: string; content: string }>; userName?: string } = {};
    try {
      body = await request.json();
      console.log('Received body:', JSON.stringify(body, null, 2));
    } catch (e) {
      console.log('No body or invalid JSON:', e);
    }
    
    let conversationText = '';
    
    if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
      console.log('Using messages from body, count:', body.messages.length);
      const displayName = body.userName || 'User';
      conversationText = body.messages
        .map(m => `${m.role === 'user' ? displayName : 'AI'}: ${m.content}`)
        .join('\n');
      console.log('Conversation text:', conversationText.substring(0, 500));
    } else {
      console.log('No messages in body, fetching from database');
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select(`
          id,
          transcript,
          messages (
            role,
            content,
            timestamp_ms
          )
        `)
        .eq('photo_id', photoId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (convError) {
        console.error('Error fetching conversation:', convError);
        return NextResponse.json({ error: 'Failed to fetch conversation' }, { status: 502 });
      }

      if (!conversations || conversations.length === 0) {
        return NextResponse.json({ error: 'No conversation found for this photo' }, { status: 404 });
      }

      const conversation = conversations[0];
      
      if (conversation.messages && conversation.messages.length > 0) {
        const sortedMessages = [...conversation.messages].sort(
          (a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0)
        );
        conversationText = sortedMessages
          .map(m => `${m.role === 'user' ? (body.userName || 'User') : 'AI'}: ${m.content}`)
          .join('\n');
      } else if (conversation.transcript) {
        try {
          const messages = JSON.parse(conversation.transcript);
          conversationText = messages
            .map((m: { role: string; content: string }) => 
              `${m.role === 'user' ? (body.userName || 'User') : 'AI'}: ${m.content}`
            )
            .join('\n');
        } catch {
          return NextResponse.json({ error: 'Invalid conversation transcript' }, { status: 400 });
        }
      }
    }

    if (!conversationText || conversationText.trim().length === 0) {
      return NextResponse.json({ error: 'Conversation is empty' }, { status: 400 });
    }

    const responseText = await generateText(
      `${FACT_EXTRACTION_PROMPT}\n\nConversation to analyze:\n${conversationText}`
    );
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse facts response:', responseText);
      return NextResponse.json({ error: 'Failed to extract facts' }, { status: 500 });
    }

    let extractedFacts: ExtractedFacts;
    try {
      extractedFacts = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('JSON parse error:', parseError, jsonMatch[0]);
      return NextResponse.json({ error: 'Failed to parse extracted facts' }, { status: 500 });
    }

    const completeness = calculateCompleteness(extractedFacts);

    const { error: photoUpdateError } = await supabase
      .from('photos')
      .update({ summary: extractedFacts.summary })
      .eq('id', photoId);

    if (photoUpdateError) {
      console.error('Error updating photo summary:', photoUpdateError);
    } else {
      console.log('Successfully updated photo summary for:', photoId);
    }

    let storyId: string | null = null;
    
    try {
      const { data: existingStory } = await supabase
        .from('photo_stories')
        .select('id')
        .eq('photo_id', photoId)
        .single();

      const storyData = {
        photo_id: photoId,
        who_facts: extractedFacts.who,
        what_facts: extractedFacts.what,
        when_facts: extractedFacts.when,
        where_facts: extractedFacts.where,
        why_facts: extractedFacts.why,
        conversation_summary: extractedFacts.summary,
        completeness_score: completeness,
        updated_at: new Date().toISOString(),
      };

      if (existingStory) {
        await supabase
          .from('photo_stories')
          .update(storyData)
          .eq('id', existingStory.id);
        storyId = existingStory.id;
      } else {
        const { data: newStory } = await supabase
          .from('photo_stories')
          .insert(storyData)
          .select('id')
          .single();
        storyId = newStory?.id || null;
      }
    } catch (e) {
      console.log('Could not save to photo_stories (table may not exist):', e);
    }

    return NextResponse.json({
      id: storyId,
      photo_id: photoId,
      who: extractedFacts.who,
      what: extractedFacts.what,
      when: extractedFacts.when,
      where: extractedFacts.where,
      why: extractedFacts.why,
      summary: extractedFacts.summary,
      completeness: completeness,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Fact extraction error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: photoId } = await params;
    
    if (!photoId) {
      return NextResponse.json({ error: 'Photo ID is required' }, { status: 400 });
    }

    const supabase = createServerClient();

    const { data: story, error } = await supabase
      .from('photo_stories')
      .select('*')
      .eq('photo_id', photoId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'No facts found for this photo' }, { status: 404 });
      }
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    return NextResponse.json({
      id: story.id,
      photo_id: story.photo_id,
      who: story.who_facts || [],
      what: story.what_facts || [],
      when: story.when_facts || [],
      where: story.where_facts || [],
      why: story.why_facts || [],
      summary: story.conversation_summary || '',
      completeness: story.completeness_score || 0,
      created_at: story.created_at,
      updated_at: story.updated_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
