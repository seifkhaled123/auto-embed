import * as p from "@clack/prompts";

export const CANCEL = Symbol("auto-embed.cancel");
export type Cancel = typeof CANCEL;

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectQuestion<T> {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
}

export interface TextQuestion {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}

export interface PromptDriver {
  intro(title: string): void;
  outro(message: string): void;
  select<T>(question: SelectQuestion<T>): Promise<T | Cancel>;
  multiSelect<T>(question: SelectQuestion<T> & { required?: boolean }): Promise<T[] | Cancel>;
  text(question: TextQuestion): Promise<string | Cancel>;
  password(question: Omit<TextQuestion, "initialValue">): Promise<string | Cancel>;
  confirm(question: { message: string; initialValue?: boolean }): Promise<boolean | Cancel>;
  note(message: string, title?: string): void;
}

export class ClackPromptDriver implements PromptDriver {
  intro(title: string): void {
    p.intro(title);
  }

  outro(message: string): void {
    p.outro(message);
  }

  async select<T>(question: SelectQuestion<T>): Promise<T | Cancel> {
    const answer = await p.select({
      message: question.message,
      options: question.options as never,
      initialValue: question.initialValue,
    });
    return p.isCancel(answer) ? CANCEL : (answer as T);
  }

  async multiSelect<T>(
    question: SelectQuestion<T> & { required?: boolean },
  ): Promise<T[] | Cancel> {
    const answer = await p.multiselect({
      message: question.message,
      options: question.options as never,
      initialValues: question.initialValue === undefined ? undefined : [question.initialValue],
      required: question.required,
    });
    return p.isCancel(answer) ? CANCEL : (answer as T[]);
  }

  async text(question: TextQuestion): Promise<string | Cancel> {
    const answer = await p.text(question);
    return p.isCancel(answer) ? CANCEL : answer;
  }

  async password(question: Omit<TextQuestion, "initialValue">): Promise<string | Cancel> {
    const answer = await p.password(question);
    return p.isCancel(answer) ? CANCEL : answer;
  }

  async confirm(question: { message: string; initialValue?: boolean }): Promise<boolean | Cancel> {
    const answer = await p.confirm(question);
    return p.isCancel(answer) ? CANCEL : answer;
  }

  note(message: string, title?: string): void {
    p.note(message, title);
  }
}
