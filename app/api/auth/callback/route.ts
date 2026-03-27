import { handleAuth } from "@workos-inc/authkit-nextjs";
import { ensureUserKey } from "@/lib/ensure-user-key";

export const GET = handleAuth({
  onSuccess: async ({ user }) => {
    if (user) {
      await ensureUserKey(user.id);
    }
  },
});
