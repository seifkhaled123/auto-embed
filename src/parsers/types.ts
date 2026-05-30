export type ContentType =
  | "markdown"
  | "pdf"
  | "html"
  | "docx"
  | "text"
  | "json"
  | "csv"
  | "code";

export interface ParsedSection {
  text: string;
  meta: Record<string, unknown>;
}

export interface ParsedDocument {
  sourcePath: string;
  contentType: ContentType;
  sections: ParsedSection[];
}

export interface Parser {
  parse(sourcePath: string): Promise<ParsedDocument>;
}
