import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

export async function extractBrand(imageBuffer: Buffer, mimeType: string): Promise<string> {
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          {
            text: 'This is an advertisement screenshot. What is the brand or company being advertised? Reply with ONLY the brand name (1-4 words max), nothing else. If you cannot determine the brand, reply with "Unknown".',
          },
        ],
      },
    ],
  })

  return result.text?.trim() || 'Unknown'
}
