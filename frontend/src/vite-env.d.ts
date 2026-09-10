/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_API_URL?: string;
  /** Set to "false" to build an InnoServe-safe version with no school name/logo. Defaults to shown. */
  readonly VITE_SHOW_SCHOOL_BRANDING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
