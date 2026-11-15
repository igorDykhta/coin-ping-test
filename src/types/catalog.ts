import type { ReferenceRecord, ResonancePeak } from "./coinPing.js";

export type CoinInput = {
  name: string;
  country?: string;
  denomination?: string;
  yearFrom?: number;
  yearTo?: number;
  mint?: string;
  variant?: string;
  composition?: string;
  notes?: string;
};

export type Coin = CoinInput & {
  id: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CoinSummary = Coin & {
  primaryObverseId: number | null;
  primaryReverseId: number | null;
  imageCount: number;
  referenceCount: number;
  sessionCount: number;
  nominalWeight: number | null;
};

export type Metric = "weight" | "density" | "conductivity";

export const MEASUREMENT_UNITS: Record<Metric, string> = {
  weight: "g",
  density: "g/cm³",
  conductivity: "MS/m",
};

export type SpecificationInput = {
  metric: Metric;
  nominal?: number;
  min?: number;
  max?: number;
  source?: string;
  notes?: string;
};

export type Specification = SpecificationInput & {
  id: number;
  coinId: number;
};

export type MeasurementInput = {
  metric: Metric;
  value: number;
  specificationId?: number | null;
  method?: string;
  notes?: string;
  measuredAt?: string;
};

export type MeasurementStatus = "within" | "outside" | "not-assessed";

export type Measurement = MeasurementInput & {
  id: number;
  sessionId: number;
  measuredAt: string;
  specification: Specification | null;
  status: MeasurementStatus;
};

export type ImageSide = "obverse" | "reverse" | "edge";
export type CoinFace = Exclude<ImageSide, "edge">;

export type ImageImportInput = {
  coinId: number;
  side: ImageSide;
  role?: "reference" | "candidate";
  credit?: string;
  source?: string;
};

export type CoinImage = ImageImportInput & {
  id: number;
  role: "reference" | "candidate";
  isPrimary: boolean;
  width: number;
  height: number;
  createdAt: string;
};

export type LayerTransform = { x: number; y: number; rotation: number; scale: number };

export type ImageAlignment = {
  reference: LayerTransform;
  candidate: LayerTransform;
  opacity: number;
  view: "overlay" | "side-by-side" | "alternate";
  locked: boolean;
  guides: boolean;
  rimRadius: number;
  guideX?: number;
  guideY?: number;
  zoom: number;
  pan: { x: number; y: number };
};

export type ComparisonInput = {
  side: CoinFace;
  referenceImageId: number;
  candidateImageId: number;
  alignment: ImageAlignment;
  notes?: string;
};

export type ImageComparison = ComparisonInput & {
  id: number;
  sessionId: number;
  createdAt: string;
  updatedAt: string;
};

export type SoundResultInput = {
  label: string;
  peaks: ResonancePeak[];
  notes?: string;
  matches?: { referenceId: number; label: string; score: number }[];
};

export type SoundResult = SoundResultInput & {
  id: number;
  sessionId: number;
  createdAt: string;
};

export type SessionInput = {
  label: string;
  notes?: string;
};

export type Session = SessionInput & {
  id: number;
  coinId: number;
  createdAt: string;
  updatedAt: string;
  measurements: Measurement[];
  comparisons: ImageComparison[];
  soundResults: SoundResult[];
};

export type CoinDetail = CoinSummary & {
  images: CoinImage[];
  specifications: Specification[];
  references: ReferenceRecord[];
  sessions: Session[];
};

export type CoinCatalogApi = {
  listCoins: () => Promise<CoinSummary[]>;
  getCoin: (id: number) => Promise<CoinDetail>;
  createCoin: (input: CoinInput) => Promise<CoinDetail>;
  updateCoin: (id: number, input: CoinInput) => Promise<CoinDetail>;
  archiveCoin: (id: number) => Promise<void>;
  restoreCoin: (id: number) => Promise<void>;
  createSpecification: (coinId: number, input: SpecificationInput) => Promise<Specification>;
  updateSpecification: (id: number, input: SpecificationInput) => Promise<Specification>;
  deleteSpecification: (id: number) => Promise<void>;
  importImage: (input: ImageImportInput) => Promise<CoinImage | null>;
  setPrimaryImage: (id: number) => Promise<void>;
  deleteImage: (id: number) => Promise<void>;
  linkReference: (id: number, coinId: number | null) => Promise<ReferenceRecord>;
  createSession: (coinId: number, input: SessionInput) => Promise<Session>;
  updateSession: (id: number, input: SessionInput) => Promise<Session>;
  createMeasurement: (sessionId: number, input: MeasurementInput) => Promise<Measurement>;
  createComparison: (sessionId: number, input: ComparisonInput) => Promise<ImageComparison>;
  updateComparison: (id: number, input: ComparisonInput) => Promise<ImageComparison>;
  saveSoundResult: (sessionId: number, input: SoundResultInput) => Promise<SoundResult>;
  exportBackup: () => Promise<boolean>;
  importBackup: () => Promise<boolean>;
};
