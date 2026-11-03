import { useEffect, useState } from "react";

export function useImageLibraryRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => window.eco?.onImageLibraryChanged?.(() => setRevision((value) => value + 1)), []);
  return revision;
}
