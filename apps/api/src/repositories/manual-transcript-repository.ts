import type { ManualTranscriptAnalysis } from '@itc/domain';

export interface ManualTranscriptPage {
  transcripts: ManualTranscriptAnalysis[];
  total: number;
}

export interface ManualTranscriptRepository {
  create(transcript: ManualTranscriptAnalysis): void;
  get(id: string): ManualTranscriptAnalysis | undefined;
  list(): ManualTranscriptPage;
}

/** Process-local storage for the manual transcript demo route. */
export class InMemoryManualTranscriptRepository implements ManualTranscriptRepository {
  private readonly transcripts = new Map<string, ManualTranscriptAnalysis>();

  create(transcript: ManualTranscriptAnalysis): void {
    this.transcripts.set(transcript.id, transcript);
  }

  get(id: string): ManualTranscriptAnalysis | undefined {
    return this.transcripts.get(id);
  }

  list(): ManualTranscriptPage {
    const transcripts = [...this.transcripts.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { transcripts, total: transcripts.length };
  }
}
