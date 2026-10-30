export type AgeRange =
  | "child"
  | "teen"
  | "young-adult"
  | "adult"
  | "older-adult";

export type Emotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "afraid"
  | "curious"
  | "whispering"
  | "excited";

export interface CharacterVoiceProfile {
  characterId: string;
  displayName: string;
  ageRange: AgeRange;
  voiceDescription: string;
  accent?: string;
  voiceId?: string;
}

export interface PerformanceCue {
  emotion?: Emotion;
  soundEffect?: string;
  musicMood?: string;
}

export interface ChapterDraft {
  chapterNumber: number;
  title: string;
  sourceText: string;
}

export interface CreateAudiobookRequest {
  bookTitle: string;
  desiredChapterCount: number;
  characterVoices: CharacterVoiceProfile[];
  includeSoundEffects: boolean;
  includeMusic: boolean;
}
