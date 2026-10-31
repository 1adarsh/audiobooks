import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DocumentPickerAsset } from "expo-document-picker";

const API_BASE_URL_STORAGE_KEY = "storybook-audio-api-base-url";
const DEFAULT_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";
let apiBaseUrl = DEFAULT_API_BASE_URL;
let apiSettingsPromise: Promise<void> | null = null;

function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid API address, such as http://192.168.1.20:8000.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("The API address must be an HTTP or HTTPS URL without credentials.");
  }
  return value.trim().replace(/\/+$/, "");
}

async function loadApiSettings(): Promise<void> {
  if (!apiSettingsPromise) {
    apiSettingsPromise = AsyncStorage.getItem(API_BASE_URL_STORAGE_KEY)
      .then((savedApiBaseUrl) => {
        if (savedApiBaseUrl) {
          apiBaseUrl = normalizeApiBaseUrl(savedApiBaseUrl);
        }
      })
      .catch((error: unknown) => {
        apiSettingsPromise = null;
        throw new Error(
          `Unable to load the saved API address: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
  await apiSettingsPromise;
}

export async function getApiBaseUrl(): Promise<string> {
  await loadApiSettings();
  return apiBaseUrl;
}

export async function setApiBaseUrl(value: string): Promise<void> {
  await loadApiSettings();
  const normalizedApiBaseUrl = normalizeApiBaseUrl(value);
  try {
    await AsyncStorage.setItem(API_BASE_URL_STORAGE_KEY, normalizedApiBaseUrl);
  } catch (error) {
    throw new Error(
      `Unable to save the API address: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  apiBaseUrl = normalizedApiBaseUrl;
}

async function fetchApi(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "Can't reach the Storybook Audio API. Start the API server and check that this device can reach it.",
      );
    }
    throw error;
  }
}

export async function getApiHealth(): Promise<{ status: string }> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchApi(`${baseUrl}/api/health`);
  if (!response.ok) {
    throw new Error(`API health check failed: ${response.status}`);
  }
  return response.json() as Promise<{ status: string }>;
}

export interface GeneratedAudio {
  audioUrl: string;
  downloadUrl: string;
  chapters: number;
  timings: Array<{
    text: string;
    start: number;
    end: number;
    wordStarts: number[];
  }>;
}

export type NarrationStyle = "gentle" | "expressive";

export async function importStoryDocument(
  asset: DocumentPickerAsset,
): Promise<{ text: string }> {
  const baseUrl = await getApiBaseUrl();
  const formData = new FormData();
  if (Platform.OS === "web") {
    if (!asset.file) {
      throw new Error("The selected document could not be read by the browser.");
    }
    formData.append("file", asset.file, asset.name);
  } else {
    const file = {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? "application/octet-stream",
    };
    formData.append("file", file as unknown as Blob);
  }

  const response = await fetchApi(`${baseUrl}/api/audio/import`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await getApiError(response, "Document import failed"));
  }

  const result = (await response.json()) as { text?: string };
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Document import returned no story text.");
  }
  return { text: result.text };
}

export interface AnalyzedSegment {
  text: string;
  speaker: string;
  emotion: string;
  emotionConfidence: number;
  isDialogue: boolean;
}

export interface StoryAnalysis {
  characters: Array<{ name: string; mentions: number }>;
  narratorDetected: boolean;
  segments: AnalyzedSegment[];
  music: { mood: string; style: string; intensity: string };
  segmentsAnalyzed: number;
  totalSegments: number;
  truncated: boolean;
}

interface AudioGenerationResponse {
  audio_url: string;
  download_url: string;
  chapters: number;
  timings: Array<{
    text: string;
    start: number;
    end: number;
    word_starts: number[];
  }>;
}

interface StoryAnalysisResponse {
  characters: Array<{ name: string; mentions: number }>;
  narrator_detected: boolean;
  segments: Array<{
    text: string;
    speaker: string;
    emotion: string;
    emotion_confidence: number;
    is_dialogue: boolean;
  }>;
  music: { mood: string; style: string; intensity: string };
  segments_analyzed: number;
  total_segments: number;
  truncated: boolean;
}

type ApiErrorResponse = { detail?: string };

async function getApiError(response: Response, fallback: string): Promise<string> {
  const result = (await response.json()) as ApiErrorResponse;
  return result.detail ?? `${fallback} (${response.status}).`;
}

export async function generateAudio(
  text: string,
  title: string,
  chapterCount: number,
  onUploadProgress?: (progress: number) => void,
  voiceStyle: NarrationStyle = "gentle",
): Promise<GeneratedAudio> {
  const baseUrl = await getApiBaseUrl();
  const payload = JSON.stringify({
    text,
    title,
    chapter_count: chapterCount,
    voice_style: voiceStyle,
  });

  const result = await new Promise<AudioGenerationResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${baseUrl}/api/audio/generate`);
    request.setRequestHeader("Content-Type", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onUploadProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.upload.addEventListener("load", () => onUploadProgress?.(100));
    request.addEventListener("error", () => {
      reject(
        new Error(
          "Can't reach the Storybook Audio API. Start the API server and check that this device can reach it.",
        ),
      );
    });
    request.addEventListener("load", () => {
      let response: AudioGenerationResponse | ApiErrorResponse;
      try {
        response = JSON.parse(request.responseText) as
          | AudioGenerationResponse
          | ApiErrorResponse;
      } catch {
        reject(
          new Error(
            request.status >= 200 && request.status < 300
              ? "The audio service returned an invalid response."
              : `Audio conversion failed (${request.status}).`,
          ),
        );
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(
          new Error(
            ("detail" in response && response.detail) ||
              `Audio conversion failed (${request.status}).`,
          ),
        );
        return;
      }
      if (!("audio_url" in response) || !("download_url" in response)) {
        reject(new Error("Audio conversion returned an invalid response."));
        return;
      }
      resolve(response);
    });
    request.send(payload);
  });

  return {
    audioUrl: new URL(result.audio_url, baseUrl).toString(),
    downloadUrl: new URL(result.download_url, baseUrl).toString(),
    chapters: result.chapters,
    timings: result.timings.map((timing) => ({
      text: timing.text,
      start: timing.start,
      end: timing.end,
      wordStarts: timing.word_starts,
    })),
  };
}

export async function analyzeStory(
  text: string,
  bookId: string,
): Promise<StoryAnalysis> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchApi(`${baseUrl}/api/audio/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, book_id: bookId }),
  });
  if (!response.ok) {
    throw new Error(await getApiError(response, "Story analysis failed"));
  }

  const result = (await response.json()) as StoryAnalysisResponse;
  return {
    characters: result.characters,
    narratorDetected: result.narrator_detected,
    segments: result.segments.map((segment) => ({
      text: segment.text,
      speaker: segment.speaker,
      emotion: segment.emotion,
      emotionConfidence: segment.emotion_confidence,
      isDialogue: segment.is_dialogue,
    })),
    music: result.music,
    segmentsAnalyzed: result.segments_analyzed,
    totalSegments: result.total_segments,
    truncated: result.truncated,
  };
}

export async function saveAnalysisFeedback(
  bookId: string,
  category: "speaker" | "emotion" | "music_mood",
  targetText: string,
  correctedValue: string,
): Promise<void> {
  const baseUrl = await getApiBaseUrl();
  const response = await fetchApi(`${baseUrl}/api/audio/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      book_id: bookId,
      category,
      target_text: targetText,
      corrected_value: correctedValue,
    }),
  });
  if (!response.ok) {
    throw new Error(await getApiError(response, "Saving feedback failed"));
  }
}
