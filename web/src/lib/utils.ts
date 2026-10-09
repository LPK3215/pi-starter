import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn / assistant-ui registry 组件统一使用的类名合并器。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
