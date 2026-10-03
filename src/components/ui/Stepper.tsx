import "./stepper-local.css";
import { Children, useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Stepper as ArcStepper } from "../arc/stepper/stepper";
import { Button } from "./button";

interface StepperProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  initialStep?: number;
  onStepChange?: (step: number) => void;
  onFinalStepCompleted?: () => void;
  stepCircleContainerClassName?: string;
  stepContainerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  backButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  nextButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  backButtonText?: string;
  nextButtonText?: string;
  finalButtonText?: string;
  disableStepIndicators?: boolean;
  renderStepIndicator?: (props: { step: number; currentStep: number; onStepClick: (clicked: number) => void }) => ReactNode;
}

const SETUP_LABELS = ["Project", "Runtime", "Goal", "Ready"];

export default function Stepper({
  children, initialStep = 1, onStepChange, onFinalStepCompleted,
  stepCircleContainerClassName = "", stepContainerClassName = "",
  contentClassName = "", footerClassName = "", backButtonProps = {},
  nextButtonProps = {}, backButtonText = "Back", nextButtonText = "Continue",
  finalButtonText = "Complete", disableStepIndicators = false,
  renderStepIndicator, className = "", ...rest
}: StepperProps) {
  const steps = Children.toArray(children);
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const completed = currentStep > steps.length;

  useEffect(() => {
    const content = contentRef.current;
    if (!content || completed) return;
    const measure = () => setHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [currentStep, completed]);

  function goTo(next: number) {
    if (next < 1 || next > steps.length + 1 || next === currentStep) return;
    setDirection(next < currentStep ? "back" : "forward");
    setCurrentStep(next);
    if (next > steps.length) onFinalStepCompleted?.();
    else onStepChange?.(next);
  }

  const { className: backClass = "", onClick: backClick, ...backRest } = backButtonProps;
  const { className: nextClass = "", onClick: nextClick, ...nextRest } = nextButtonProps;
  const progressSteps = steps.map((_, index) => ({ id: String(index), label: SETUP_LABELS[index] ?? `Step ${index + 1}` }));

  return (
    <div {...rest} className={`setup-wizard ${className}`.trim()}>
      <div className={stepCircleContainerClassName}>
        <div className={`${stepContainerClassName} flex w-full items-center p-8`}>
          <ArcStepper current={Math.min(currentStep - 1, steps.length - 1)} compact label="Project setup progress" steps={progressSteps} />
        </div>
        {!disableStepIndicators && renderStepIndicator && (
          <div className="flex gap-2 px-8">{steps.map((_, index) => (
            <span key={index}>{renderStepIndicator({ step: index + 1, currentStep, onStepClick: goTo })}</span>
          ))}</div>
        )}
        <div className={`stepper-content space-y-2 px-8 ${contentClassName}`} style={{ height: completed ? 0 : height }}>
          {!completed && <div key={currentStep} ref={contentRef} className="stepper-panel" data-direction={direction}>
            {steps[currentStep - 1]}
          </div>}
        </div>
        {!completed && <div className={`px-8 pb-8 ${footerClassName}`}>
          <div className={`mt-10 flex ${currentStep > 1 ? "justify-between" : "justify-end"}`}>
            {currentStep > 1 && <Button variant="ghost" {...backRest} className={`setup-back ${backClass}`} onClick={(event) => { backClick?.(event); if (!event.defaultPrevented) goTo(currentStep - 1); }}>{backButtonText}</Button>}
            <Button variant="ghost" {...nextRest} className={`setup-next ${nextClass}`} onClick={(event) => { nextClick?.(event); if (!event.defaultPrevented) goTo(currentStep + 1); }}>{currentStep === steps.length ? finalButtonText : nextButtonText}</Button>
          </div>
        </div>}
      </div>
    </div>
  );
}

export function Step({ children }: { children: ReactNode }) {
  return <div className="px-8">{children}</div>;
}
