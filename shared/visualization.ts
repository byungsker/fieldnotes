export type VisualizationScalar = string | number | boolean | null;
export type VisualizationValue = VisualizationScalar | VisualizationValue[] | { [key: string]: VisualizationValue };

export type VisualizationFilter = {
  field: string;
  operator: "eq" | "contains" | "exists" | "before" | "after" | "in";
  value?: VisualizationValue;
};

export type VisualizationQuery = {
  folderId?: string | null;
  search?: string;
  where?: VisualizationFilter[];
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
};

export type VisualizationNote = {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  excerpt: string;
  frontmatter: Record<string, VisualizationValue>;
  frontmatterError?: string;
};

export type VisualizationQueryResponse = {
  notes: VisualizationNote[];
  sequence: number;
};

export type FieldnotesViewConfig = {
  version: 1;
  view: "table" | "calendar" | "custom";
  query?: VisualizationQuery;
  columns?: string[];
  dateField?: string;
  labelField?: string;
  js?: string;
};
