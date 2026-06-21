import { redirect } from "next/navigation";

// The tool lives under the gated (app) route group at /email-extractor. "/" just
// forwards there; unauthenticated hits are bounced to /login by middleware.ts
// before this runs.
export default function RootPage(): never {
  redirect("/email-extractor");
}
