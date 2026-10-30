export interface PickedBook {
  name: string;
  uri: string;
  size?: number;
}

export interface PlaybackCue {
  id: string;
  speaker: "Narrator" | "Milo" | "Elara" | "Gideon";
  text: string;
  timestamp: string;
  tone: "warm" | "bright" | "dramatic" | "calm";
  chapterNumber?: number;
}
