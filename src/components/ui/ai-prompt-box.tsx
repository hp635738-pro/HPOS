/**
 * ai-prompt-box
 *
 * ported verbatim from hp635738-pro/compo (21st.dev/r/jahed/ai-prompt-box by Hossain Jahed / EaseMize UI, MIT). Changes for HPOS/Vite: next/image replaced with plain <img>.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Type,
  Boxes,
  Code,
  Globe,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import React from "react";

// Utility function for className merging
const cn = (...classes: (string | undefined | null | false)[]) =>
  classes.filter(Boolean).join(" ");

// Embedded CSS for minimal custom styles
const styles = `
  *:focus-visible {
    outline-offset: 0 !important;
    --ring-offset: 0 !important;
  }
  textarea::-webkit-scrollbar {
    width: 6px;
  }
  textarea::-webkit-scrollbar-track {
    background: transparent;
  }
  textarea::-webkit-scrollbar-thumb {
    background-color: #444444;
    border-radius: 3px;
  }
  textarea::-webkit-scrollbar-thumb:hover {
    background-color: #555555;
  }
`;

// Hook to inject styles on client only
const useStyleInjection = () => {
  React.useEffect(() => {
    const styleId = "ai-prompt-box-styles";
    if (typeof document !== "undefined" && !document.getElementById(styleId)) {
      const styleSheet = document.createElement("style");
      styleSheet.id = styleId;
      styleSheet.innerText = styles;
      document.head.appendChild(styleSheet);
    }
  }, []);
};

// Textarea Component
interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "scrollbar-thin scrollbar-thumb-[#444444] scrollbar-track-transparent hover:scrollbar-thumb-[#555555] flex min-h-[44px] w-full resize-none rounded-md border-none bg-transparent px-3 py-2.5 text-base text-gray-100 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      rows={1}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

// Tooltip Components
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "fade-in-0 zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 animate-in overflow-hidden rounded-md border border-[#333333] bg-[#1F2023] px-3 py-1.5 text-sm text-white shadow-md data-[state=closed]:animate-out",
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

// Dialog Components
const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[90vw] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border border-[#333333] bg-[#1F2023] p-0 shadow-xl duration-300 data-[state=closed]:animate-out data-[state=open]:animate-in md:max-w-[800px]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute top-4 right-4 z-10 rounded-full bg-[#2E3033]/80 p-2 transition-all hover:bg-[#2E3033]">
        <X className="h-5 w-5 text-gray-200 hover:text-white" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "font-semibold text-gray-100 text-lg leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

// Button Component
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
}
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    const variantClasses = {
      default: "bg-white hover:bg-white/80 text-black",
      outline: "border border-[#444444] bg-transparent hover:bg-[#3A3A40]",
      ghost: "bg-transparent hover:bg-[#3A3A40]",
    };
    const sizeClasses = {
      default: "h-10 px-4 py-2",
      sm: "h-8 px-3 text-sm",
      lg: "h-12 px-6",
      icon: "h-8 w-8 rounded-full aspect-[1/1]",
    };
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

// ImageViewDialog Component
interface ImageViewDialogProps {
  imageUrl: string | null;
  onClose: () => void;
}
const ImageViewDialog: React.FC<ImageViewDialogProps> = ({
  imageUrl,
  onClose,
}) => {
  if (!imageUrl) return null;
  return (
    <Dialog open={!!imageUrl} onOpenChange={onClose}>
      <DialogContent className="max-w-[90vw] border-none bg-transparent p-0 shadow-none md:max-w-[800px]">
        <DialogTitle className="sr-only">Image Preview</DialogTitle>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative overflow-hidden rounded-2xl bg-[#1F2023] shadow-2xl"
        >
          <div className="relative max-h-[80vh] w-full">
            <img
              src={imageUrl}
alt="Full preview"
              className="rounded-2xl object-contain"
            />
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
};

// PromptInput Context and Components
interface PromptInputContextType {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
}
const PromptInputContext = React.createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
});
function usePromptInput() {
  const context = React.useContext(PromptInputContext);
  if (!context)
    throw new Error("usePromptInput must be used within a PromptInput");
  return context;
}

interface PromptInputProps {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}
const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      className,
      isLoading = false,
      maxHeight = 240,
      value,
      onValueChange,
      onSubmit,
      children,
      disabled = false,
      onDragOver,
      onDragLeave,
      onDrop,
    },
    ref,
  ) => {
    const [internalValue, setInternalValue] = React.useState(value || "");
    const handleChange = (newValue: string) => {
      setInternalValue(newValue);
      onValueChange?.(newValue);
    };
    return (
      <TooltipProvider>
        <PromptInputContext.Provider
          value={{
            isLoading,
            value: value ?? internalValue,
            setValue: onValueChange ?? handleChange,
            maxHeight,
            onSubmit,
            disabled,
          }}
        >
          <div
            ref={ref}
            className={cn(
              "rounded-3xl border border-[#444444] bg-[#1F2023] p-2 shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300",
              isLoading && "border-red-500/70",
              className,
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            role="form"
            aria-label="Prompt Input Area"
          >
            {children}
          </div>
        </PromptInputContext.Provider>
      </TooltipProvider>
    );
  },
);
PromptInput.displayName = "PromptInput";

interface PromptInputTextareaProps {
  disableAutosize?: boolean;
  placeholder?: string;
}
const PromptInputTextarea: React.FC<
  PromptInputTextareaProps & React.ComponentProps<typeof Textarea>
> = ({
  className,
  onKeyDown,
  disableAutosize = false,
  placeholder,
  ...props
}) => {
  const { value, setValue, maxHeight, onSubmit, disabled } = usePromptInput();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (disableAutosize || !textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height =
      typeof maxHeight === "number"
        ? `${Math.min(textareaRef.current.scrollHeight, maxHeight)}px`
        : `min(${textareaRef.current.scrollHeight}px, ${maxHeight})`;
  }, [maxHeight, disableAutosize]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit?.();
    }
    onKeyDown?.(e);
  };

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn("text-base", className)}
      disabled={disabled}
      placeholder={placeholder}
      {...props}
    />
  );
};

interface PromptInputActionsProps
  extends React.HTMLAttributes<HTMLDivElement> {}
const PromptInputActions: React.FC<PromptInputActionsProps> = ({
  children,
  className,
  ...props
}) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

interface PromptInputActionProps extends React.ComponentProps<typeof Tooltip> {
  tooltip: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string; // Add className
}
const PromptInputAction: React.FC<PromptInputActionProps> = ({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}) => {
  const { disabled } = usePromptInput();
  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild disabled={disabled}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

// Custom Divider Component
const CustomDivider: React.FC = () => (
  <div className="relative mx-1 h-6 w-[1.5px]">
    <div
      className="absolute inset-0 rounded-full bg-gradient-to-t from-transparent via-[#9b87f5]/70 to-transparent"
      style={{
        clipPath:
          "polygon(0% 0%, 100% 0%, 100% 40%, 140% 50%, 100% 60%, 100% 100%, 0% 100%, 0% 60%, -40% 50%, 0% 40%)",
      }}
    />
  </div>
);

// Provider-grouped agent models (as requested) shown in the Models picker
const MODEL_TIERS: { tier: string; models: string[] }[] = [
  { tier: "Featured", models: ["Max"] },
  { tier: "OpenAI", models: ["o3-mini","o1","o1-preview","o1-mini","gpt-4o","gpt-4o-latest","gpt-4o-mini","gpt-4-turbo","gpt-4-0125-preview","gpt-4-1106-preview","gpt-4-0613","gpt-3.5-turbo-0125","gpt-3.5-turbo-1106"] },
  { tier: "Anthropic (Claude)", models: ["claude-3-5-sonnet-20241022","claude-3-5-sonnet","claude-3-5-haiku","claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-2.1","claude-2.0","claude-instant-1.2"] },
  { tier: "Google", models: ["gemini-2.0-flash-exp","gemini-2.0-flash-thinking-exp","gemini-2.0-pro-exp","gemini-1.5-pro","gemini-1.5-flash","gemini-1.5-flash-8b","gemini-1.0-pro","gemma-2-27b-it","gemma-2-9b-it","gemma-2-2b-it"] },
  { tier: "DeepSeek", models: ["deepseek-r1","deepseek-v3","deepseek-coder-v2","deepseek-llm-67b-chat"] },
  { tier: "Meta (Llama)", models: ["llama-3.3-70b-instruct","llama-3.1-405b-instruct","llama-3.1-70b-instruct","llama-3.1-8b-instruct","llama-3-70b-instruct","llama-3-8b-instruct","llama-2-70b-chat","llama-2-13b-chat"] },
  { tier: "Alibaba (Qwen)", models: ["qwen2.5-max","qwen2.5-plus","qwen2.5-72b-instruct","qwen2.5-32b-instruct","qwen2.5-14b-instruct","qwen2.5-7b-instruct","qwq-32b-preview","qwen2-72b-instruct","qwen1.5-110b-chat"] },
  { tier: "Mistral AI", models: ["mistral-large-2411","mistral-large-2407","mistral-medium","mistral-small","mistral-7b-instruct","mixtral-8x22b-instruct","mixtral-8x7b-instruct","codestral-22b","pixtral-12b"] },
  { tier: "xAI", models: ["grok-2","grok-2-mini","grok-beta"] },
  { tier: "Cohere", models: ["command-r-plus-08-2024","command-r-plus","command-r"] },
  { tier: "Microsoft", models: ["phi-4","phi-3.5-mini-instruct","phi-3-medium-4k-instruct","phi-3-mini-4k-instruct","wizardlm-2-8x22b","wizardlm-2-7b"] },
  { tier: "NVIDIA", models: ["llama-3.1-nemotron-70b-instruct","nemotron-4-340b-instruct"] },
  { tier: "01.AI (Yi)", models: ["yi-lightning","yi-large","yi-1.5-34b-chat","yi-34b-chat"] },
  { tier: "Amazon", models: ["amazon-nova-pro","amazon-nova-lite","amazon-nova-micro"] },
  { tier: "Other open-source", models: ["dbrx-instruct","starling-lm-7b-beta","zephyr-7b-beta","vicuna-33b","vicuna-13b","glm-4-9b-chat","solar-10.7b-instruct","openchat-3.5"] },
];

// Max (default) + all provider models, flat list
const AI_MODELS = ["Max", ...MODEL_TIERS.flatMap((t) => t.models)];

// Coding-specialist models shown when Code mode is active
const CODE_MODEL_TIERS: { tier: string; models: string[] }[] = [
  { tier: "Featured", models: ["Max"] },
  { tier: "OpenAI (top coding & reasoning)", models: ["o3-mini","o1","o1-preview","o1-mini","gpt-4o","gpt-4o-latest","gpt-4o-mini","gpt-4-turbo","gpt-4-0125-preview"] },
  { tier: "Anthropic (Claude)", models: ["claude-3-5-sonnet-20241022","claude-3-5-sonnet","claude-3-5-haiku","claude-3-opus","claude-3-sonnet"] },
  { tier: "DeepSeek (coding & reasoning)", models: ["deepseek-r1","deepseek-v3","deepseek-coder-v2-instruct","deepseek-coder-33b-instruct","deepseek-coder-6.7b-instruct"] },
  { tier: "Alibaba (Qwen Coder)", models: ["qwen2.5-coder-32b-instruct","qwen2.5-coder-14b-instruct","qwen2.5-coder-7b-instruct","qwq-32b-preview","qwen2.5-72b-instruct","qwen2.5-max"] },
  { tier: "Mistral AI (Codestral)", models: ["codestral-2501","codestral-22b","mistral-large-2411","mixtral-8x22b-instruct"] },
  { tier: "Google", models: ["gemini-2.0-flash-thinking-exp","gemini-2.0-flash-exp","gemini-2.0-pro-exp","gemini-1.5-pro","gemini-1.5-flash","codegemma-7b-it"] },
  { tier: "Meta (Code Llama & Llama 3)", models: ["llama-3.3-70b-instruct","llama-3.1-405b-instruct","llama-3.1-70b-instruct","codellama-70b-instruct","codellama-34b-instruct","codellama-13b-instruct"] },
  { tier: "01.AI (Yi-Coder)", models: ["yi-coder-9b-chat","yi-coder-1.5b-chat","yi-lightning"] },
  { tier: "BigCode / HuggingFace", models: ["starcoder2-15b","starcoder2-33b","starcoder-15b"] },
  { tier: "Other code models", models: ["wizardcoder-33b-v1.1","phind-codellama-34b-v2","phi-4","phi-3.5-mini-instruct"] },
];

// Search-specialist models shown when Search mode is active
const SEARCH_MODEL_TIERS: { tier: string; models: string[] }[] = [
  { tier: "Featured", models: ["Max"] },
  { tier: "Perplexity AI (search engines)", models: ["sonar-pro","sonar-reasoning","sonar","perplexity-online"] },
  { tier: "OpenAI (web search)", models: ["gpt-4o (with search)","gpt-4o-mini (with search)","searchgpt-prototype","o3-mini (with search)"] },
  { tier: "Google (search grounding)", models: ["gemini-2.0-flash (with search)","gemini-1.5-pro (with search)","gemini-1.5-flash (with search)","gemini-2.0-flash-thinking-exp (search)"] },
  { tier: "Anthropic (web search)", models: ["claude-3-5-sonnet (web-search)","claude-3-5-haiku (web-search)","claude-3-opus (web-search)"] },
  { tier: "DeepSeek (live search)", models: ["deepseek-r1 (with web-search)","deepseek-v3 (with web-search)"] },
  { tier: "xAI (X & live web search)", models: ["grok-2 (with web-search)","grok-2-mini (with web-search)"] },
  { tier: "Cohere (search & RAG)", models: ["command-r-plus (grounded search)","command-r (grounded search)"] },
  { tier: "Mistral AI", models: ["mistral-large (web-search)","le-chat (web-search)"] },
  { tier: "You.com", models: ["youchat","you-search-pro"] },
  { tier: "Meta / open source (web-RAG)", models: ["llama-3.3-70b-instruct (with search)","llama-3.1-405b-instruct (with search)","llama-3.1-70b-instruct (with search)","qwen2.5-72b-instruct (with search)"] },
];

// Brand logo path data (24x24 viewBox, via simple-icons) for the dummy model list
const MODEL_LOGOS: Record<string, string> = {
  "Max":
    "M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z",
  "GPT-5":
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  "Claude Sonnet 4.5":
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  "Gemini 2.5 Pro":
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  "Llama 4 Maverick":
    "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z",
  "Grok 4":
    "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  "DeepSeek V3.2":
    "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45",
  "Qwen":
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm3.5 10.5 5 5-2 2-5-5z",
  "Mistral":
    "M2 3h20v4H2zM2 10h14v4H2zM2 17h20v4H2z",
  "Cohere":
    "M12 2l4 5-4 5-4-5zM5 12l4 5-4 5-4-5zM19 12l4 5-4 5-4-5z",
  "Microsoft":
    "M3 3h8.5v8.5H3zM13.5 3H22v8.5h-8.5zM3 13.5h8.5V22H3zM13.5 13.5H22V22h-8.5z",
  "Yi":
    "M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z",
  "Amazon":
    "M3 16.5c6 3.5 12 3.5 18 0L22.5 19c-6.5 4-14.5 4-21 0z",
  "BigCode":
    "M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  "Perplexity":
    "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z",
  "You.com":
    "M4 5h4v7a4 4 0 0 0 8 0V5h4v7a8 8 0 0 1-16 0z",
};

// Resolve a brand logo for model ids (prefix-based)
const logoFor = (name: string): string | undefined => {
  if (MODEL_LOGOS[name]) return MODEL_LOGOS[name];
  if (name.startsWith("claude")) return MODEL_LOGOS["Claude Sonnet 4.5"];
  if (/^(o1|o3|gpt)/.test(name)) return MODEL_LOGOS["GPT-5"];
  if (name.startsWith("deepseek")) return MODEL_LOGOS["DeepSeek V3.2"];
  if (name.startsWith("qwen") || name.startsWith("qwq")) return MODEL_LOGOS["Qwen"];
  if (name.startsWith("gemini") || name.startsWith("gemma")) return MODEL_LOGOS["Gemini 2.5 Pro"];
  if (name.startsWith("llama") || name.startsWith("nemotron")) return MODEL_LOGOS["Llama 4 Maverick"];
  if (/^(mistral|mixtral|codestral|pixtral)/.test(name)) return MODEL_LOGOS["Mistral"];
  if (name.startsWith("grok")) return MODEL_LOGOS["Grok 4"];
  if (name.startsWith("command")) return MODEL_LOGOS["Cohere"];
  if (name.startsWith("phi") || name.startsWith("wizardlm")) return MODEL_LOGOS["Microsoft"];
  if (name.startsWith("yi")) return MODEL_LOGOS["Yi"];
  if (name.startsWith("amazon")) return MODEL_LOGOS["Amazon"];
  if (name.startsWith("codellama") || name.startsWith("wizardcoder")) return MODEL_LOGOS["Llama 4 Maverick"];
  if (name.startsWith("codegemma")) return MODEL_LOGOS["Gemini 2.5 Pro"];
  if (name.startsWith("starcoder")) return MODEL_LOGOS["BigCode"];
  if (name.startsWith("sonar") || name.startsWith("perplexity")) return MODEL_LOGOS["Perplexity"];
  if (name.startsWith("youchat") || name.startsWith("you-search")) return MODEL_LOGOS["You.com"];
  if (name.startsWith("le-chat")) return MODEL_LOGOS["Mistral"];
  if (name.startsWith("searchgpt")) return MODEL_LOGOS["GPT-5"];
  if (name.startsWith("yi")) return MODEL_LOGOS["Yi"];
  return MODEL_LOGOS["Max"];
};

// Small brand logo rendered from MODEL_LOGOS path data
const ModelLogo: React.FC<{ name: string; className?: string }> = ({
  name,
  className,
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    className={cn("h-3.5 w-3.5 flex-shrink-0", className)}
  >
    <path d={logoFor(name)} />
  </svg>
);
export { ModelLogo as ModelIcon };

// Main PromptInputBox Component
interface PromptInputBoxProps {
  onSend?: (
    message: string,
    files?: File[],
    meta?: { model?: string },
  ) => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  hasConversation?: boolean;
  onNewChat?: () => void;
  onModeChange?: (mode: "text" | "search" | "models" | "code") => void;
}
export const PromptInputBox = React.forwardRef(
  (props: PromptInputBoxProps, ref: React.Ref<HTMLDivElement>) => {
    const {
      onSend = () => {},
      isLoading = false,
      placeholder = "Type your message here...",
      className,
      hasConversation = false,
      onNewChat,
      onModeChange,
    } = props;

    // Inject styles on client only
    useStyleInjection();

    const [input, setInput] = React.useState("");
    const [files, setFiles] = React.useState<File[]>([]);
    const [filePreviews, setFilePreviews] = React.useState<{
      [key: string]: string;
    }>({});
    const [selectedImage, setSelectedImage] = React.useState<string | null>(
      null,
    );
    const [showSearch, setShowSearch] = React.useState(false);
    const [showThink, setShowThink] = React.useState(true);
    const [showCode, setShowCode] = React.useState(false);
    const [showCanvas, setShowCanvas] = React.useState(false);
    const [selectedModel, setSelectedModel] = React.useState<string | null>(
      AI_MODELS[0],
    );
    const uploadInputRef = React.useRef<HTMLInputElement>(null);
    const promptBoxRef = React.useRef<HTMLDivElement>(null);

    const [pendingMode, setPendingMode] = React.useState<
      "text" | "search" | "models" | "code" | null
    >(null);

    const applyMode = (mode: "text" | "search" | "models" | "code") => {
      // Search/Text/Code behave like a radio group: exactly one stays
      // selected at all times (Text is the default). Models toggles on its own.
      if (mode === "search") {
        setShowSearch(true);
        setShowThink(false);
        setShowCode(false);
      } else if (mode === "text") {
        setShowThink(true);
        setShowSearch(false);
        setShowCode(false);
      } else if (mode === "code") {
        setShowCode(true);
        setShowSearch(false);
        setShowThink(false);
      } else {
        setShowCanvas((prev) => !prev);
      }
      onModeChange?.(mode);
    };

    const requestMode = (mode: "text" | "search" | "models" | "code") => {
      if (hasConversation) setPendingMode(mode);
      else applyMode(mode);
    };

    const handleToggleChange = (value: string) => {
      if (value === "search") requestMode("search");
      else if (value === "think") requestMode("text");
    };

    const handleCodeToggle = () => requestMode("code");

    const handleCanvasToggle = () => applyMode("models");

    const confirmNewChat = () => {
      if (!pendingMode) return;
      onNewChat?.();
      applyMode(pendingMode);
      setPendingMode(null);
    };

    const isImageFile = (file: File) => file.type.startsWith("image/");

    const processFile = React.useCallback((file: File) => {
      if (!file.type.startsWith("image/")) {
        console.log("Only image files are allowed");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        console.log("File too large (max 10MB)");
        return;
      }
      setFiles([file]);
      const reader = new FileReader();
      reader.onload = (e) =>
        setFilePreviews({ [file.name]: e.target?.result as string });
      reader.readAsDataURL(file);
    }, []);

    const handleDragOver = React.useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    const handleDragLeave = React.useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    const handleDrop = React.useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer.files);
        const imageFiles = files.filter((file) => isImageFile(file));
        if (imageFiles.length > 0 && imageFiles[0]) processFile(imageFiles[0]);
      },
      [isImageFile, processFile],
    );

    const handleRemoveFile = (index: number) => {
      const fileToRemove = files[index];
      if (fileToRemove && filePreviews[fileToRemove.name]) setFilePreviews({});
      setFiles([]);
    };

    const openImageModal = (imageUrl: string) => setSelectedImage(imageUrl);

    const handlePaste = React.useCallback(
      (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.type.indexOf("image") !== -1) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              processFile(file);
              break;
            }
          }
        }
      },
      [processFile],
    );

    React.useEffect(() => {
      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }, [handlePaste]);

    const handleSubmit = () => {
      if (input.trim() || files.length > 0) {
        onSend(input, files, { model: selectedModel ?? undefined });
        setInput("");
        setFiles([]);
        setFilePreviews({});
      }
    };

    const hasContent = input.trim() !== "" || files.length > 0;

    return (
      <>
        <PromptInput
          value={input}
          onValueChange={setInput}
          isLoading={isLoading}
          onSubmit={handleSubmit}
          className={cn(
            "w-full border-[#444444] bg-[#1F2023] shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300 ease-in-out",
            className,
          )}
          disabled={isLoading}
          ref={ref || promptBoxRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 p-0 pb-1 transition-all duration-300">
              {files.map((file, index) => (
                <div key={index} className="group relative">
                  {file.type.startsWith("image/") &&
                    filePreviews[file.name] && (
                      <div
                        className="h-16 w-16 cursor-pointer overflow-hidden rounded-xl transition-all duration-300"
                        onClick={() => {
                          const preview = filePreviews[file.name];
                          if (preview) openImageModal(preview);
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            const preview = filePreviews[file.name];
                            if (preview) openImageModal(preview);
                          }
                        }}
                      >
                        {filePreviews[file.name] && (
                          <img
                            src={filePreviews[file.name] || ""}
alt={file.name}
                            className="h-full w-full object-cover"
                          />
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveFile(index);
                          }}
                          className="absolute top-1 right-1 rounded-full bg-black/70 p-0.5 opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3 text-white" />
                        </button>
                      </div>
                    )}
                </div>
              ))}
            </div>
          )}

          <div
            className={cn(
              "transition-all duration-300",
              "opacity-100",
            )}
          >
            <div
              className={cn(
                "grid transition-all duration-300 ease-out",
                showCanvas
                  ? "grid-rows-[0fr] opacity-0 invisible"
                  : "grid-rows-[1fr] opacity-100",
              )}
              aria-hidden={showCanvas || undefined}
            >
              <div className="overflow-hidden">
                <PromptInputTextarea
                  placeholder={
                    showSearch
                      ? "Search the web..."
                        : showThink
                          ? "Type your text..."
                          : showCode
                            ? "Paste code or describe a bug..."
                            : placeholder
                  }
                  className="text-base"
                />
              </div>
            </div>

            <div
              className={cn(
                "grid transition-all duration-300 ease-out",
                showCanvas
                  ? "grid-rows-[1fr] opacity-100"
                  : "grid-rows-[0fr] opacity-0 invisible pointer-events-none",
              )}
              aria-hidden={!showCanvas || undefined}
            >
              <div className="overflow-hidden">
                <div className="flex min-h-[96px] w-full flex-col gap-2 px-3 py-2.5">
                    <p className="text-xs tracking-widest text-gray-500 uppercase">
                      Select a model
                    </p>
                    <div className="flex max-h-[46vh] flex-col gap-3 overflow-y-auto pr-1">
                      {(showCode ? CODE_MODEL_TIERS : showSearch ? SEARCH_MODEL_TIERS : MODEL_TIERS).map((t) => (
                        <div key={t.tier}>
                          <p className="mb-1.5 text-[10px] tracking-widest text-gray-500 uppercase">
                            {t.tier}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {t.models.map((model) => (
                              <motion.button
                                key={model}
                                type="button"
                                initial={false}
                                animate={
                                  showCanvas
                                    ? { opacity: 1, scale: 1, y: 0 }
                                    : { opacity: 0, scale: 0.85, y: 6 }
                                }
                                transition={
                                  showCanvas
                                    ? { type: "spring", stiffness: 400, damping: 24 }
                                    : { duration: 0.15 }
                                }
                                onClick={() => {
                                  setSelectedModel(model);
                                  setShowCanvas(false);
                                }}
                                className={cn(
                                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                                  selectedModel === model
                                    ? "border-[#F97316] bg-[#F97316]/15 text-[#F97316]"
                                    : "border-[#3A3A40] text-gray-300 hover:border-[#F97316]/60 hover:text-white",
                                )}
                              >
                                <ModelLogo name={model} />
                                {model}
                              </motion.button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
              </div>
            </div>
          </div>

          <PromptInputActions className="flex items-center justify-between gap-2 p-0 pt-2">
            <div
              className={cn(
                "flex items-center gap-1 transition-opacity duration-300",
                "visible opacity-100",
              )}
            >
              <PromptInputAction tooltip="Upload image">
                <button
                  onClick={() => uploadInputRef.current?.click()}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[#9CA3AF] transition-colors hover:bg-gray-600/30 hover:text-[#D1D5DB]"
                >
                  <Paperclip className="h-5 w-5 transition-colors" />
                  <input
                    ref={uploadInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        const file = e.target.files[0];
                        if (file) processFile(file);
                      }
                      if (e.target) e.target.value = "";
                    }}
                    accept="image/*"
                  />
                </button>
              </PromptInputAction>

              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => handleToggleChange("search")}
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-full border px-2 py-1 transition-all",
                    showSearch
                      ? "border-[#1EAEDB] bg-[#1EAEDB]/15 text-[#1EAEDB]"
                      : "border-transparent bg-transparent text-[#9CA3AF] hover:text-[#D1D5DB]",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showSearch ? 360 : 0,
                        scale: showSearch ? 1.1 : 1,
                      }}
                      whileHover={{
                        rotate: showSearch ? 360 : 15,
                        scale: 1.1,
                        transition: {
                          type: "spring",
                          stiffness: 300,
                          damping: 10,
                        },
                      }}
                      transition={{
                        type: "spring",
                        stiffness: 260,
                        damping: 25,
                      }}
                    >
                      <Globe
                        className={cn(
                          "h-4 w-4",
                          showSearch ? "text-[#1EAEDB]" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showSearch && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden whitespace-nowrap text-[#1EAEDB] text-xs"
                      >
                        Search
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>

                <CustomDivider />

                <button
                  type="button"
                  onClick={() => handleToggleChange("think")}
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-full border px-2 py-1 transition-all",
                    showThink
                      ? "border-[#8B5CF6] bg-[#8B5CF6]/15 text-[#8B5CF6]"
                      : "border-transparent bg-transparent text-[#9CA3AF] hover:text-[#D1D5DB]",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        scale: showThink ? 1.2 : 1,
                        y: showThink ? -2 : 0,
                      }}
                      whileHover={{
                        scale: 1.15,
                        y: -1,
                        transition: {
                          type: "spring",
                          stiffness: 500,
                          damping: 15,
                        },
                      }}
                      transition={{
                        type: "spring",
                        stiffness: 500,
                        damping: 18,
                      }}
                    >
                      <Type
                        className={cn(
                          "h-4 w-4",
                          showThink ? "text-[#8B5CF6]" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showThink && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden whitespace-nowrap text-[#8B5CF6] text-xs"
                      >
                        Text
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>

                <CustomDivider />

                <button
                  type="button"
                  onClick={handleCodeToggle}
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-full border px-2 py-1 transition-all",
                    showCode
                      ? "border-[#34D399] bg-[#34D399]/15 text-[#34D399]"
                      : "border-transparent bg-transparent text-[#9CA3AF] hover:text-[#D1D5DB]",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showCode ? -8 : 0,
                        scale: showCode ? 1.15 : 1,
                      }}
                      whileHover={{
                        rotate: -8,
                        scale: 1.1,
                        transition: {
                          type: "spring",
                          stiffness: 400,
                          damping: 15,
                        },
                      }}
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 18,
                      }}
                    >
                      <Code
                        className={cn(
                          "h-4 w-4",
                          showCode ? "text-[#34D399]" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {showCode && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden whitespace-nowrap text-[#34D399] text-xs"
                      >
                        Code
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>

                <CustomDivider />

                <button
                  type="button"
                  onClick={handleCanvasToggle}
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-full border px-2 py-1 transition-all",
                    showCanvas
                      ? "border-[#F97316] bg-[#F97316]/15 text-[#F97316]"
                      : "border-transparent bg-transparent text-[#9CA3AF] hover:text-[#D1D5DB]",
                  )}
                >
                  <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <motion.div
                      animate={{
                        rotate: showCanvas ? 360 : 0,
                        scale: showCanvas ? 1.1 : 1,
                      }}
                      whileHover={{
                        rotate: showCanvas ? 360 : 15,
                        scale: 1.1,
                        transition: {
                          type: "spring",
                          stiffness: 300,
                          damping: 10,
                        },
                      }}
                      transition={{
                        type: "spring",
                        stiffness: 260,
                        damping: 25,
                      }}
                    >
                      <Boxes
                        className={cn(
                          "h-4 w-4",
                          showCanvas ? "text-[#F97316]" : "text-inherit",
                        )}
                      />
                    </motion.div>
                  </div>
                  <AnimatePresence>
                    {(showCanvas || selectedModel) && (
                      <motion.span
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: "auto", opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex-shrink-0 overflow-hidden whitespace-nowrap text-[#F97316] text-xs"
                      >
                        {showCanvas ? "Models" : selectedModel}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </div>
            </div>

            <PromptInputAction
              tooltip={isLoading ? "Stop generation" : "Send message"}
            >
              <Button
                variant="default"
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full transition-all duration-200",
                  hasContent
                    ? "bg-white text-[#1F2023] hover:bg-white/80"
                    : "bg-transparent text-[#9CA3AF] hover:bg-gray-600/30 hover:text-[#D1D5DB]",
                )}
                onClick={() => {
                  if (hasContent) handleSubmit();
                }}
                disabled={isLoading && !hasContent}
              >
                {isLoading ? (
                  <Square className="h-4 w-4 animate-pulse fill-[#1F2023]" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>

        <ImageViewDialog
          imageUrl={selectedImage}
          onClose={() => setSelectedImage(null)}
        />

        <Dialog
          open={pendingMode !== null}
          onOpenChange={(open) => {
            if (!open) setPendingMode(null);
          }}
        >
          <DialogContent className="max-w-[90vw] md:max-w-[420px]">
            <DialogTitle>Start a new chat?</DialogTitle>
            <p className="px-6 text-sm text-gray-400">
              Mode change karne se current conversation clear ho jayegi.
            </p>
            <div className="flex justify-end gap-2 px-6 pb-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingMode(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-[#F97316] text-black hover:bg-[#F97316]/80"
                onClick={confirmNewChat}
              >
                New Chat
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  },
);
PromptInputBox.displayName = "PromptInputBox";
