/**
 * shadcn-style composable sidebar (docs: Sidebar — "A composable, themeable
 * and customizable sidebar component").
 *
 * Adapted for HPOS:
 *  - No new dependencies: the mobile Sheet is a minimal internal overlay and
 *    the `render`/`asChild` host swap is implemented directly (no Radix
 *    Slot / meta-package needed).
 *  - Tailwind v3 syntax (arbitrary-value var() classes) — the repo runs
 *    Tailwind 3.4 with preflight OFF, and `cn` never receives conflicting
 *    classes.
 *  - The desktop panel renders as <aside> so HPOS's existing rail CSS
 *    (glass blur for the aurora preset, width/background transitions)
 *    keeps applying.
 *  - Geometry (width, icon width, row height/gap/radius/font) is fed from
 *    the existing Sidebar settings via the --rail-* CSS vars set by
 *    ThemeContext; colours come from the --sidebar-* tokens which index.css
 *    maps onto the HPOS theme vars.
 *
 * API (matches the docs page):
 *   SidebarProvider, useSidebar,
 *   Sidebar (side | variant: sidebar|floating|inset | collapsible:
 *            offcanvas|icon|none),
 *   SidebarHeader, SidebarContent, SidebarFooter,
 *   SidebarGroup, SidebarGroupLabel, SidebarGroupAction,
 *   SidebarGroupContent, SidebarMenu, SidebarMenuItem,
 *   SidebarMenuButton (render/asChild, isActive, size, variant, radius),
 *   SidebarMenuAction, SidebarMenuBadge, SidebarMenuSkeleton,
 *   SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton,
 *   SidebarTrigger, SidebarRail, SidebarInset.
 *
 * Keyboard shortcut: cmd+b / ctrl+b toggles the sidebar.
 */
import * as React from "react"
import { PanelLeftIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_ICON = "3.5rem"
const SIDEBAR_WIDTH_MOBILE = "20rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextValue = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.")
  return context
}

function useIsMobile() {
  const [mobile, setMobile] = React.useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(max-width: 768px)").matches
  )
  React.useEffect(() => {
    if (!window.matchMedia) return
    const mql = window.matchMedia("(max-width: 768px)")
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return mobile
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

function SidebarProvider({
  open: openProp,
  onOpenChange,
  defaultOpen = true,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const _open = openProp ?? open
  const _setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const nextOpen = typeof value === "function" ? value(_open) : value
      if (openProp === undefined) setOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [_open, onOpenChange, openProp]
  )

  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  const toggleSidebar = React.useCallback(() => {
    _setOpen((value) => !value)
  }, [_setOpen])

  // cmd+b / ctrl+b
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // typeof guards: the app's jsdom smoke test runs outside a browser
      // where the HTML* element globals don't exist.
      if (
        (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
        (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
        (target && target.isContentEditable)
      ) {
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === SIDEBAR_KEYBOARD_SHORTCUT) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      state: _open ? "expanded" : "collapsed",
      open: _open,
      setOpen: _setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [_open, _setOpen, openMobile, isMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={style}
        className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function Sidebar({
  side = "left",
  variant = "floating",
  collapsible = "icon",
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
}) {
  const { state } = useSidebar()
  const dataCollapsible =
    state === "collapsed" && collapsible !== "none" ? collapsible : ""

  // HPOS is a desktop app: the panel is always rendered inline (no
  // offcanvas/mobile sheet) so the rail never disappears at narrow widths,
  // matching the pre-shadcn rail. `offcanvas` therefore behaves like
  // `icon` here (width transition to the icon column).
  return (
    <div
      data-slot="sidebar"
      data-side={side}
      data-state={state}
      data-collapsible={dataCollapsible}
      data-variant={variant}
      className={cn("group peer flex h-full shrink-0 text-sidebar-foreground", className)}
      {...props}
    >
      <aside
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "relative flex h-full shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)]",
          /* no `sticky` here: HPOS's shell is a fixed 100vh flex row with no
             page scroll, and a sticky + z-auto panel becomes a stacking
             context in Chromium — that would trap the z-20 SidebarRail
             inside the panel and let main-content paint over it. The base
             `relative` is enough for the rail's positioning. */
          variant === "floating" &&
            "w-[var(--sidebar-width)] rounded-[var(--sidebar-sharp,0px)] border border-sidebar-border shadow-sm",
          variant === "inset" &&
            "fixed inset-y-0 z-10 w-[var(--sidebar-width)] border border-sidebar-border bg-sidebar shadow-sm",
          variant === "sidebar" &&
            "fixed inset-y-0 z-10 w-[var(--sidebar-width)] border-sidebar-border group-data-[collapsible=offcanvas]:w-[calc(var(--sidebar-width)_+_2rem)]",
          side === "left" && variant !== "floating" && "left-0",
          side === "right" && variant !== "floating" && "right-0"
        )}
        style={style}
      >
        {children}
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Header / Content / Footer                                           */
/* ------------------------------------------------------------------ */

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="headers"
      className={cn("flex flex-col gap-2 px-2 py-2", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto overflow-x-hidden", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 px-2 py-2", className)}
      {...props}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("group/menu-group relative w-full min-w-0", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: React.ComponentProps<"div"> & {
  render?: React.ElementType
}) {
  const Comp = (render as React.ElementType) ?? "div"
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 overflow-hidden px-2 text-xs font-medium text-sidebar-foreground opacity-70 transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:h-0 [&>span:last-child]:truncate",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupAction({
  className,
  render,
  ...props
}: React.ComponentProps<"button"> & {
  render?: React.ElementType
}) {
  const Comp = (render as React.ElementType) ?? "button"
  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        "absolute right-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:hidden [&>svg]:size-4",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("group/menu-content flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn(
        "m-0 flex w-full min-w-0 shrink-0 list-none flex-col gap-[var(--rail-gap,4px)] p-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative w-full min-w-0 shrink-0", className)}
      {...props}
    />
  )
}

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean
    render?: React.ElementType
    isActive?: boolean
    variant?: "default" | "outline"
    size?: "default" | "sm"
    radius?: "sm" | "md" | "lg"
  }
>(
  (
    {
      asChild = false,
      render,
      isActive = false,
      variant = "default",
      size = "default",
      radius = "md",
      className,
      ...props
    },
    ref
  ) => {
    // `render` (or `asChild` for the docs' render-prop usage) swaps the host
    // element; HPOS needs no Radix Slot for this.
    const Comp = (render as React.ElementType) ?? "button"
    return (
      <Comp
        ref={ref}
        type={Comp === "button" || asChild ? "button" : undefined}
        data-slot="sidebar-menu-button"
        data-sidebar="menu-button"
        data-active={isActive}
        data-size={size}
        data-variant={variant}
        data-radius={radius}
        className={cn(
          "peer group/menu-button relative flex h-[var(--rail-item-h,36px)] w-full min-w-0 items-center gap-[11px] overflow-hidden pl-[11px] pr-2 text-sidebar-foreground outline-none disabled:pointer-events-none disabled:opacity-50",
          "rounded-[var(--rail-radius,6px)] text-[length:var(--rail-font,14px)] font-medium transition-[background,color,opacity] duration-200 ease-linear",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
          "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:px-0",
          size === "sm" && "h-7",
          variant === "outline" && "border border-sidebar-border",
          className
        )}
        {...props}
      />
    )
  }
)
SidebarMenuButton.displayName = "SidebarMenuButton"

function SidebarMenuAction({
  className,
  render,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  render?: React.ElementType
  showOnHover?: boolean
}) {
  const Comp = (render as React.ElementType) ?? "button"
  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute right-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-data-[active=true]:bg-sidebar-accent peer-data-[active=true]:text-sidebar-accent-foreground md:opacity-0 md:group-hover/menu-item:opacity-100 md:group-focus-within/menu-item:opacity-100 data-[state=open]:opacity-100",
        showOnHover === false && "md:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1.5 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums text-sidebar-foreground",
        "peer-hover:bg-sidebar-accent-foreground peer-hover:text-sidebar-accent",
        "peer-data-[active=true]:bg-sidebar-primary-foreground peer-data-[active=true]:text-sidebar-primary",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  width = "100%",
}: {
  className?: string
  showIcon?: boolean
  width?: number | string
}) {
  const widthStyle = typeof width === "number" ? { width: `${width}px` } : { width }
  return (
    <div
      data-slot="sidebar-menu-skeleton"
      className={cn("flex h-8 items-center gap-2", className)}
    >
      {showIcon && <div className="size-4 shrink-0 rounded-md bg-sidebar-accent" />}
      <div
        className="h-4 max-w-full flex-1 rounded-md bg-sidebar-accent"
        style={widthStyle}
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 list-none flex-col gap-1 border-l border-sidebar-border p-0 pl-3 pr-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative w-full min-w-0", className)}
      {...props}
    />
  )
}

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<"a"> & {
    render?: React.ElementType
    size?: "sm" | "md"
    isActive?: boolean
  }
>(({ render, size = "md", isActive = false, className, ...props }, ref) => {
  const Comp = (render as React.ElementType) ?? "a"
  return (
    <Comp
      ref={ref}
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
        size === "sm" && "h-6 text-xs",
        className
      )}
      {...props}
    />
  )
})
SidebarMenuSubButton.displayName = "SidebarMenuSubButton"

/* ------------------------------------------------------------------ */
/* Trigger / Rail / Inset                                              */
/* ------------------------------------------------------------------ */

function SidebarTrigger({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()
  return (
    <button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={toggleSidebar}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
        className
      )}
      {...props}
    >
      <PanelLeftIcon className="size-4" />
      <span className="sr-only">Toggle Sidebar</span>
    </button>
  )
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()
  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      aria-label="Toggle Sidebar"
      className={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 cursor-pointer transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] sm:flex data-[state=collapsed]:w-1 data-[state=collapsed]:after:bg-sidebar-border",
        className
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "flex min-h-svh w-full min-w-0 flex-1 flex-col bg-[var(--bg)]",
        className
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
  SIDEBAR_WIDTH_MOBILE,
  SIDEBAR_KEYBOARD_SHORTCUT,
}
