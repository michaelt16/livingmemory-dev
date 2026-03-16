import { NextResponse } from 'next/server';
import { generateWithImages, generateText, fetchImageAsNovaInput, type ImagePart } from '@/lib/nova';

export async function POST(request: Request) {
  try {
    const { albumTitle, contextType, contextDescription, narrativePov, clips } = await request.json();

    const pov = narrativePov || 'first_person';
    console.log('Generate narration request:', { albumTitle, contextType, pov, clipsCount: clips?.length });

    if (!clips || clips.length === 0) {
      return NextResponse.json(
        { error: 'No clips provided' },
        { status: 400 }
      );
    }

    const imageUrls: (string | null)[] = clips.map(
      (clip: { imageUrl?: string }) => clip.imageUrl || null
    );
    const imageParts = await Promise.all(
      imageUrls.map((url) => (url ? fetchImageAsNovaInput(url) : Promise.resolve(null)))
    );
    const hasImages = imageParts.some(Boolean);
    console.log(`Multimodal narration: ${imageParts.filter(Boolean).length}/${clips.length} images loaded`);

    const clipsDescription = clips.map((clip: { order: number; story: string; hasStory: boolean; hasAnimation: boolean; perspectives?: Array<{ memberName: string; quote: string }> }, i: number) => {
      const hasRealStory = clip.hasStory !== false && clip.story && clip.story !== 'No story provided';
      const storyLine = hasRealStory
        ? clip.story
        : '[NO STORY YET — this photo has not been discussed. Generate a brief placeholder based on the photo if an image is attached, otherwise write "..." as the narration.]';
      const parts = [`Clip ${clip.order}: ${storyLine}${clip.hasAnimation ? ' (has video animation)' : ' (static photo)'}`];
      if (clip.perspectives && clip.perspectives.length > 0) {
        clip.perspectives.forEach((p: { memberName: string; quote: string }) => {
          parts.push(`  ${p.memberName}'s perspective: "${p.quote}"`);
        });
      }
      if (imageParts[i]) {
        parts.push('  [Photo image attached — use visual details you observe]');
      }
      return parts.join('\n');
    }).join('\n\n');

    const povInstructions = pov === 'first_person'
      ? `Write in FIRST PERSON. Use "I", "we", "my", "our". The narrator is someone in the family recalling these memories as their own. Example: "I still remember the way the light caught her smile that afternoon. We didn't know it then, but that was the last summer we'd all be together like this."`
      : `Write in THIRD PERSON. Use family members' real names from the perspectives. The narrator is an outside storyteller looking in. Example: "Sarah still remembers the way the light caught her mother's smile. The family didn't know it then, but that was the last summer they'd all be together like this."`;

    const textPrompt = `You are crafting voiceover narration for a family memory album called "${albumTitle}".
${hasImages ? '\nIMPORTANT: You can SEE the actual photos attached to this request. Use specific visual details you observe — colors, expressions, settings, clothing, objects, weather, body language — to make the narration vivid and grounded in reality. Do NOT make up details that aren\'t visible.\n' : ''}
${contextDescription}

${povInstructions}

Here are the clips in order:
${clipsDescription}

Write narration for each clip. Make it sound like a real person speaking — not a greeting card, not a press release. Think Ken Burns documentary, or a memoir read aloud.

Guidelines:
- Sound NATURAL. Use contractions ("didn't", "we'd", "that's"). Vary sentence length. Short punchy lines mixed with longer reflective ones.
- 2-4 sentences per clip. Rich moments get more. Simple photos get a single warm line.
- ${contextType === 'single_event' ? 'This is one event — let the story flow chronologically.' : contextType === 'memory_collection' ? 'These are different moments — find the emotional thread connecting them.' : 'These share a theme — build on it across clips.'}
- When perspectives exist from family members, weave them in conversationally. Don't list them — blend them.
- Add emotional weight. What did this moment MEAN? Why does it matter?
${hasImages ? '- Reference specific things you SEE in the photos — a color, an expression, a setting, an object. This makes the narration feel personal and real.' : '- Never describe the photo ("In this photo we see..."). Instead, tell us what we can\'t see — the feelings, the context, the before and after.'}
- Avoid clichés like "cherished memories" or "precious moments." Be specific and real.
- CRITICAL: The clipTexts array MUST have EXACTLY ${clips.length} entries — one per clip, in order. Clip 1 = index 0, Clip 2 = index 1, etc. Never skip or merge clips. For clips marked [NO STORY YET], output "..." as their narration text.

Respond in JSON format:
{
  "narration": "The full combined narration text (skip clips with no story)",
  "clipTexts": ["Narration for clip 1", "Narration for clip 2", ...]
}`;

    let text: string;
    if (hasImages) {
      const validImages: ImagePart[] = [];
      clips.forEach((clip: { order: number }, i: number) => {
        const imgPart = imageParts[i];
        if (imgPart) {
          validImages.push({
            ...imgPart,
            label: `--- Photo for Clip ${clip.order} ---`,
          });
        }
      });
      text = await generateWithImages(textPrompt, validImages);
    } else {
      text = await generateText(textPrompt);
    }

    console.log('Response text:', text.substring(0, 500));

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return NextResponse.json({
          narration: parsed.narration || '',
          clipTexts: parsed.clipTexts || [],
        });
      }
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
    }

    return NextResponse.json({
      narration: text,
      clipTexts: [],
    });

  } catch (error) {
    console.error('Generate narration error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to generate narration';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
