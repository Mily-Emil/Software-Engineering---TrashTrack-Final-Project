declare namespace Deno {
  export interface Env {
    get(key: string): string | undefined
    set(key: string, value: string): void
    toObject(): Record<string, string>
  }
  export const env: Env
  export function serve(
    handler: (req: Request) => Response | Promise<Response>
  ): void
}

declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js'
}

