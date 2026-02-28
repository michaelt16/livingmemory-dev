import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { generateWithImages, generateText, fetchImageAsNovaInput, type ImagePart } from '@/lib/nova';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: eventId } = await params;

    const body = await request.json();
    const { photos, albumTitle, members } = body;

    if (!photos || photos.length === 0) {
      return NextResponse.json({ error: 'No photos provided' }, { status: 400 });
    }

    let photoData = photos;
    if (!photoData[0]?.summary && !photoData[0]?.story) {
      const supabase = createServerClient();
      const { data: dbPhotos } = await supabase
        .from('photos')
        .select('id, original_url, thumbnail_url, animated_url, summary')
        .eq('event_id', eventId)
        .order('order_in_album', { ascending: true });

      if (dbPhotos && dbPhotos.length > 0) {
        const photoIds = dbPhotos.map(p => p.id);
        const { data: conversations } = await supabase
          .from('conversations')
          .select('photo_id, transcript, author_id')
          .in('photo_id', photoIds);

        const convMap = new Map<string, string>();
        conversations?.forEach(c => {
          if (c.transcript) convMap.set(c.photo_id, c.transcript);
        });

        photoData = dbPhotos.map(p => ({
          id: p.id,
          url: p.original_url || p.thumbnail_url,
          animatedUrl: p.animated_url,
          summary: p.summary,
          story: convMap.get(p.id) || null,
          perspectives: [],
        }));
      }
    }

    const imageUrls: (string | null)[] = photoData.map(
      (p: { url?: string; original_url?: string; thumbnail_url?: string }) =>
        p.url || p.original_url || p.thumbnail_url || null
    );
    const imageParts = await Promise.all(
      imageUrls.map((url) => (url ? fetchImageAsNovaInput(url) : Promise.resolve(null)))
    );
    const hasImages = imageParts.some(Boolean);
    console.log(`Storybook multimodal: ${imageParts.filter(Boolean).length}/${photoData.length} images loaded`);

    const membersList = (members || [])
      .map((m: { name: string; relationship?: string }) => `${m.name} (${m.relationship || 'family member'})`)
      .join(', ');

    const photosDescription = photoData.map((p: {
      id: string;
      summary?: string;
      story?: string;
      perspectives?: Array<{ memberName: string; quote: string }>;
    }, i: number) => {
      const parts = [`Photo ${i + 1} (ID: ${p.id})`];
      if (p.summary) parts.push(`  Context: ${p.summary}`);
      if (p.story) parts.push(`  Story told: ${p.story}`);
      if (p.perspectives && p.perspectives.length > 0) {
        p.perspectives.forEach((per: { memberName: string; quote: string }) => {
          parts.push(`  ${per.memberName}'s perspective: "${per.quote}"`);
        });
      }
      if (imageParts[i]) {
        parts.push('  [Photo image attached — use the visual details you observe]');
      }
      if (!p.summary && !p.story && (!p.perspectives || p.perspectives.length === 0)) {
        parts.push('  (No story captured yet — describe what you SEE in the photo)');
      }
      return parts.join('\n');
    }).join('\n\n');

    const textPrompt = `You are EVA, a warm and eloquent storyteller for a family memory preservation app called "Living Memory."

You are creating a Living Storybook narration for the album "${albumTitle || 'Family Memories'}".
Family members: ${membersList || 'A loving family'}
${hasImages ? '\nIMPORTANT: You can SEE the actual photos attached. Use specific visual details you observe — expressions, colors, settings, clothing, body language, objects — to make the narration vivid, personal, and grounded in what\'s really there. This is what makes your storytelling special.\n' : ''}
Here are the photos in order, with their stories and family perspectives:

${photosDescription}

Create a flowing, cohesive narrative that weaves all these photos into one beautiful story. For each photo, write a narration section.

Rules:
- Write in a warm, intimate, documentary-style voice — like a beloved family member telling the story
- Each section should be 2-4 sentences. Let sections with rich stories breathe longer (3-4 sentences). Simpler moments can be brief (1-2 sentences).
- When multiple family members shared perspectives, weave them together naturally
${hasImages ? '- Reference specific visual details you SEE: "the way her hand rests on his shoulder", "sunlight streaming through the kitchen window", "that well-worn blue sweater." These details make stories feel REAL.' : '- For photos without stories, create a brief poetic description based on the context'}
- Create natural bridges between sections — don't force connections, but find emotional throughlines
- Use family members' names when referencing their perspectives
- The tone should feel like looking through an album together, remembering and sharing

Respond with ONLY a valid JSON array (no markdown, no code fences):
[
  { "photoId": "...", "narrationText": "...", "speakerName": "Narrator" },
  ...
]

Each object must have photoId (matching the photo ID provided), narrationText (the narration for that section), and speakerName (always "Narrator").`;

    let text: string;
    if (hasImages) {
      const validImages: ImagePart[] = [];
      photoData.forEach((p: { id: string }, i: number) => {
        const imgPart = imageParts[i];
        if (imgPart) {
          validImages.push({
            ...imgPart,
            label: `--- Photo ${i + 1} (ID: ${p.id}) ---`,
          });
        }
      });
      text = await generateWithImages(textPrompt, validImages);
    } else {
      text = await generateText(textPrompt);
    }

    let sections;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      sections = JSON.parse(cleaned);
    } catch {
      console.error('Failed to parse storybook response:', text);
      sections = photoData.map((p: { id: string; summary?: string; story?: string }, i: number) => ({
        photoId: p.id,
        narrationText: p.story || p.summary || `A treasured moment, photo ${i + 1} of this collection.`,
        speakerName: 'Narrator',
      }));
    }

    return NextResponse.json({ sections, albumTitle: albumTitle || 'Family Memories' });
  } catch (error) {
    console.error('Storybook generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate storybook', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
