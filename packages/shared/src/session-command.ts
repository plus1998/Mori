/** Only a standalone command is executable; mentions and longer names remain ordinary text. */
export function isCompactCommand(prompt: string): boolean {
  return prompt.trim() === "/compact";
}
