import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// For PRD reasoning — smarter, slower
export const reasoningModel = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  generationConfig: { responseMimeType: "application/json" },
  safetySettings: [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ],
});

/** Fallback when gemini-2.5-pro is unavailable (quota, outage). */
export const reasoningFallbackModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: { responseMimeType: "application/json" },
  safetySettings: [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ],
});

// For vision agent loop — fast, multimodal
export const visionModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: { responseMimeType: "application/json" },
});

// For free-text responses (bug analysis, summaries)
export const analysisModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
});
