/**
 * Toast — the shadcn/ui "base" (Base UI) implementation.
 *
 * Port of the shadcn registry item (bases/base/ui/toast.tsx, style base-nova)
 * with HPOS substitutions:
 *   - IconPlaceholder (multi-icon registry)  → lucide-react icons
 *   - shadcn Button `render` targets         → Base UI's default <button>
 *     hosts, styled with HPOS tokens
 *   - Tailwind v4 syntax → v3 (data-expanded: → data-[expanded]:,
 *     h-(--var) → h-[var(--var)], no opacity-modifier on var() colours)
 *   - viewport z-50 → z-[300] (HPOS z-map: palette 250, modals 200+;
 *     toasts must float above everything, same as the old toast host)
 *   - `border` gets `border-border` (HPOS preflight is off, so the v3
 *     default border colour would be currentColor)
 *
 * Usage (matches the shadcn docs):
 *   import { toast } from '@/components/ui/toast'
 *   const id = toast.add({
 *     title: 'Event created',
 *     description: 'Sunday, December 3 at 9:00 AM',
 *     actionProps: { children: 'Undo', onClick() { toast.close(id) } },
 *   })
 *
 * `type` renders a status icon: 'success' | 'info' | 'warning' | 'error' |
 * 'loading'. `toast.promise(...)` drives one toast through
 * loading → success/error. Mount <Toaster /> once (main.jsx does this via
 * the legacy ToastProvider bridge in ./Toast.jsx).
 */
import * as React from 'react'
import { Toast as ToastPrimitive } from '@base-ui/react/toast'
import {
  CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const toast = ToastPrimitive.createToastManager()

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />
}

/* HPOS setting (prefs.toastPosition). Bottom-anchored variants only — Base
   UI's stacking math (offset/peek/swipe) assumes the viewport sits at the
   bottom edge, so top positions are not supported. */
const VIEWPORT_POSITIONS: Record<string, string> = {
  'bottom-right': "sm:right-4 sm:left-auto sm:mx-0 sm:w-full",
  'bottom-left': "sm:left-4 sm:right-auto sm:mx-0 sm:w-full",
  'bottom-center': "sm:mx-auto sm:w-full",
}

function ToastViewport({ className, position, ...props }: ToastPrimitive.Viewport.Props & { position?: string }) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-4 z-[300] mx-auto w-auto max-w-sm outline-none",
        VIEWPORT_POSITIONS[position] ?? VIEWPORT_POSITIONS['bottom-right'],
        className
      )}
      {...props}
    />
  )
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "cn-toast group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom border border-border bg-popover text-popover-foreground shadow-lg will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring",
        "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-[var(--height)] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-[expanded]:h-[var(--toast-height)] data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-[limited]:opacity-0 data-[starting-style]:[transform:translateY(150%)]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
        "data-[ending-style]:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-[ending-style]:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-[ending-style]:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-[ending-style]:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-[expanded]:data-[ending-style]:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-[expanded]:data-[ending-style]:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-[expanded]:data-[ending-style]:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-[expanded]:data-[ending-style]:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[behind]:opacity-0 data-[expanded]:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

function ToastDescription({
  className,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function ToastAction({ className, ...props }: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "shrink-0 h-7 rounded-md border border-border bg-background px-2.5 text-xs font-bold text-foreground transition-colors hover:bg-accent",
        className
      )}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Close toast"
      className={cn(
        "relative shrink-0 grid h-6 w-6 place-items-center rounded-md text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground",
        className
      )}
      {...props}
    >
      {children ?? <XIcon size={14} aria-hidden="true" />}
    </ToastPrimitive.Close>
  )
}

function ToastIcon({ type }: { type?: string }) {
  let icon: React.ReactNode = null

  if (type === 'success') {
    icon = <CircleCheckIcon size={16} className="text-[var(--success)]" aria-hidden="true" />
  }
  if (type === 'info') {
    icon = <InfoIcon size={16} className="text-[var(--accent)]" aria-hidden="true" />
  }
  if (type === 'warning') {
    icon = <TriangleAlertIcon size={16} className="text-[var(--warning)]" aria-hidden="true" />
  }
  if (type === 'error') {
    icon = <OctagonXIcon size={16} className="text-destructive" aria-hidden="true" />
  }
  if (type === 'loading') {
    icon = <Loader2Icon size={16} className="animate-spin" aria-hidden="true" />
  }

  if (!icon) {
    return null
  }

  return (
    <span
      data-slot="toast-icon"
      className="shrink-0 [&_svg]:pointer-events-none"
    >
      {icon}
    </span>
  )
}

function ToastList({ showIcons = true, showClose = true }: { showIcons?: boolean; showClose?: boolean }) {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toastItem) => (
    <Toast key={toastItem.id} toast={toastItem}>
      <ToastContent>
        {showIcons && <ToastIcon type={toastItem.type} />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastTitle />
          <ToastDescription />
        </div>
        <ToastAction />
        {showClose && <ToastClose />}
      </ToastContent>
    </Toast>
  ))
}

function Toaster({
  children,
  toastManager = toast,
  position,
  showIcons = true,
  showClose = true,
  ...props
}: ToastPrimitive.Provider.Props & {
  position?: string
  showIcons?: boolean
  showClose?: boolean
}) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport position={position}>
          <ToastList showIcons={showIcons} showClose={showClose} />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const createToastManager = ToastPrimitive.createToastManager
const useToastManager = ToastPrimitive.useToastManager

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
}
