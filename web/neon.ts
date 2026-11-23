import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  // Video files the owners upload (the owners' note 7 of 2026-11-22; "Set up neon", 2026-11-23): read by anyone, as
  // the website's pages show them; written only with the branch's storage credential, through upload addresses the
  // site gives an owner (src/server/video-store.ts).
  buckets: {
    videos: { access: "public_read" },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
