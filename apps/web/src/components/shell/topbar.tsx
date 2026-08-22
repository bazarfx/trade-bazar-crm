'use client';

import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui';
import { demoAvatarFor } from '@/components/demo-avatar';
import { usePageTitle } from './page-title';

/**
 * The app shell's top bar, measured off the `CRM _ Leads` frame:
 * `Rectangle 2` at x=256 y=0, 1184×68, surface fill, 1px bottom border. The
 * signed-in user's profile lives HERE, not in the sidebar (which carries the
 * logo slot instead). Page content starts below this bar.
 *
 * The profile group, `Profil`, measured in that same frame:
 *
 *   FRAME             Profil    @1216,12  208x44  flex-row gap:12
 *     ROUNDED_RECTANGLE Avatar    @0,0     44x44   r:36.22  fills:[IMAGE/FILL]
 *     FRAME             Content   @56,4    152x36  flex-row gap:4
 *       FRAME             Frame 1   @0,0     112x36  flex-col gap:4
 *         TEXT              Title     @0,0     112x20  Medium 14px/20  #111827
 *                                                      "Andrew Smith"
 *         TEXT              OVERLINE  @0,24    112x12  Medium 10px/12 ls:0.4
 *                                                      #6b7280  "Product Manager"
 *       FRAME             Icon / Chevron @136,10 16x16
 *
 * TWO THINGS HERE CONTRADICT AN EARLIER READING, and the frame wins both:
 *
 *  1. **The NAME is on top, the role below it.** `Title` sits at y=0 and
 *     `OVERLINE` at y=24 (20 + the 4px gap). The opposite order came from the
 *     `Sidebar - Open` COMPONENT, where the same two nodes really are the
 *     other way round (OVERLINE @0,0, Title @0,16). docs/DESIGN-SPEC.md's own
 *     rule settles it: "When the template and a screen disagree, the screen
 *     wins" — and the profile is only ON a screen in the top bar.
 *  2. **The overline is `#6b7280`, not `#757575`.** #757575 is the sidebar
 *     component's muted grey (`--globalcolors-neutral-80` is our nearest
 *     token for it). The top bar's overline is measured #6b7280 exactly,
 *     which IS a token: `--body`.
 *
 * The 16x16 `Icon / Chevron` is deliberately NOT drawn. It promises a profile
 * menu, and there is none — sign-out lives in the sidebar's "Logout Account"
 * row. A chevron that opens nothing is a dead affordance, which this codebase
 * refuses elsewhere for the same reason (see the sort/filter controls in
 * `components/ui/table.tsx`). It goes in the moment there is a menu behind it.
 *
 * THE PAGE TITLE LIVES HERE, on the left of the same band. Measured at
 * @286,21 (26px line box → 21…47) on every designed frame, inside this bar's
 * 0…68. See components/shell/page-title.tsx for the evidence and for why the
 * page declares it through a context rather than the layout passing it down.
 *
 * 'use client' only for that context read — the bar still has no state of its
 * own and no handlers.
 */
export interface ShellUser {
  /**
   * The signed-in user's id. Carried for the avatar alone — it is what makes
   * the demo face STABLE for a given person rather than changing per render.
   * See components/demo-avatar.ts.
   */
  id: string;
  fullName: string;
  roleName: string;
}

export function TopBar({ user }: { user: ShellUser }): ReactElement {
  const title = usePageTitle();

  return (
    // The file's 68px height is never hardcoded: 44px avatar + 12px padding
    // top and bottom = 68, derived exactly the way the frame's auto-layout
    // derives it. `px-4` is the measured 16px right margin (the group ends at
    // x=1424 of 1440). Sticky so the chrome holds still while the page
    // scrolls, matching the sidebar's behaviour.
    //
    // The 1px bottom rule is an INSET SHADOW, not `border-b`. Measured: the
    // file's `Rectangle 2` is 1184x68 *including* its 1px stroke, because a
    // Figma stroke does not participate in auto-layout. A CSS border does —
    // under border-box it added a 69th pixel, so every page below the bar
    // started 1px low. A spread-free inset shadow paints the same line on the
    // box's last row and takes no space. Same trick, same reason, as the panel
    // stroke in components/ui/popup.tsx.
    <header
      className={
        'sticky top-0 z-10 flex h-[68px] shrink-0 items-center justify-between gap-4 bg-surface ' +
        'px-4 shadow-[inset_0_-1px_0_0_var(--border)]'
      }
    >
      {/* Title @286,21 of 1440 → 30px from the content column's left edge at
          256. `px-4` above gives 16 of that; the remaining 14 is `pl-[14px]`
          here. Both are measured, not chosen. `text-title` is the file's
          Medium 24px / ls 0.4 (tailwind.config.ts). Empty on screens that
          declare no title, which is every screen the file does not draw. */}
      <h1
        className="min-w-0 truncate pl-[14px] text-title font-medium text-heading"
        title={title ?? undefined}
      >
        {title}
      </h1>

      {/* Profil: avatar 44 + Content, gap 12. `shrink-0` so a long page title
          truncates instead of squeezing the profile. */}
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        {/* DEMO imagery until an IMAGE field is wired — demo-avatar.ts says why
            it is a function of the id rather than a stored value. With no id
            (never, for a signed-in human) `Avatar` falls back to initials. */}
        <Avatar size={44} name={user.fullName} {...avatarSrc(user.id)} />
        {/* Frame 1: flex-col gap:4, name first. */}
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-medium text-heading" title={user.fullName}>
            {user.fullName}
          </span>
          {/* Measured #6b7280 → `--body`. `text-overline` carries the file's
              10px/12 Medium with ls 0.4 (tailwind.config.ts). */}
          <span className="truncate text-overline text-body" title={user.roleName}>
            {user.roleName}
          </span>
        </span>
      </div>
    </header>
  );
}

/**
 * `src` is optional on `AvatarProps` and this project compiles with
 * `exactOptionalPropertyTypes` off but `noUncheckedIndexedAccess` on — spread
 * the prop only when there is one, rather than passing an explicit
 * `undefined`, so the absent case stays absent instead of becoming a value.
 */
function avatarSrc(id: string): { src?: string } {
  const src = demoAvatarFor(id);
  return src === undefined ? {} : { src };
}
