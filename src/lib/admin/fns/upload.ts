/**
 * Admin server function: upload a site image to Supabase Storage.
 *
 * `adminFnMiddleware` is the real authorization boundary (see its own doc
 * comment) — nothing upstream of it (route guards, UI state) can substitute
 * for it, since a client can always POST straight to /_serverFn/uploadImage.
 *
 * method: "POST" because the payload is FormData (a multipart body).
 * createServerFn only allows a validator to resolve to a bare FormData type
 * for POST — see ValidateValidatorInput in
 * @tanstack/start-client-core/createServerFn.d.ts — GET would fail to type
 * check (and throws at runtime: "FormData is not supported with GET
 * requests").
 *
 * `@/server/*` is imported dynamically INSIDE the handler, not as a top-level
 * static import: this file is reachable from the client bundle (ImageField.tsx
 * imports `uploadImage` to get the client fetcher stub), so a static import of
 * server-only code here would pull it into that module graph and trip the
 * build's import protection. Same pattern as src/lib/admin/middleware.ts.
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export type UploadImageResult = { key: string; url: string };

export const uploadImage = createServerFn({ method: "POST" })
  .inputValidator((data: FormData) => data)
  .middleware([adminFnMiddleware])
  .handler(async ({ data }): Promise<UploadImageResult> => {
    const file = data.get("file");
    if (!(file instanceof File)) {
      throw new Error("缺少要上傳的檔案");
    }

    const { uploadSiteImage } = await import("@/server/storage");
    return uploadSiteImage(file);
  });
