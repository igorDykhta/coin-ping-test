export type ResonancePeak = {
  frequencyHz: number;
  magnitude: number;
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
