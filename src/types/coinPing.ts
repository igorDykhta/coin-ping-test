export type ResonancePeak = {
  frequencyHz: number;
  magnitude: number;
  /**
   * Peak duration class. Populated by the live ping detector; absent for
   * legacy reference rows that were saved before this field existed.
   *  - "long":  the bin stayed within the sustain window for ≳ 200 ms, so it
   *             corresponds to a clearly ringing resonance.
   *  - "short": the bin stayed sustained for 100–200 ms — a real tone, but
   *             closer in character to a transient.
   */
  kind?: "long" | "short";
  /** Max consecutive sustain duration (ms) measured for this peak's bin. */
  sustainMs?: number;
  /**
   * Average dB power integrated after the initial transient window during
   * ping capture. Used internally for ranking; absent for manual peaks.
   */
  accumulatedPowerDb?: number;
};

export type ReferenceInput = {
  label: string;
  peaks: ResonancePeak[];
};

export type ReferenceRecord = ReferenceInput & {
  id: number;
  createdAt: string;
};

export type CoinPingApi = {
  listReferences: () => Promise<ReferenceRecord[]>;
  createReference: (input: ReferenceInput) => Promise<ReferenceRecord>;
  deleteReference: (id: number) => Promise<void>;
};
