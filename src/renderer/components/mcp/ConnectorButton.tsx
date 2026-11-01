import React, { useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import ConnectorIcon from '../icons/ConnectorIcon';
import ConnectorPickerPopover from './ConnectorPickerPopover';

interface ConnectorButtonProps {
  onManageConnectors: () => void;
  className?: string;
  iconClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The connector picker's toolbar entry, sitting beside the kit picker.
 *
 * The `+` menu carries the same list, but the toolbar button is the one you
 * reach for when you already know which connector the task needs — it does
 * not make you open a menu first.
 */
const ConnectorButton: React.FC<ConnectorButtonProps> = ({
  onManageConnectors,
  className = '',
  iconClassName = 'h-5 w-5',
  onOpenChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = () => {
    setIsOpen((previous) => {
      const next = !previous;
      onOpenChange?.(next);
      return next;
    });
  };

  const handleClose = () => {
    onOpenChange?.(false);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground ${className}`}
        title={i18nService.t('coworkConnectors')}
        aria-label={i18nService.t('coworkConnectors')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <ConnectorIcon className={iconClassName} />
      </button>
      <ConnectorPickerPopover
        isOpen={isOpen}
        onClose={handleClose}
        anchorRef={buttonRef}
        onManageConnectors={onManageConnectors}
      />
    </div>
  );
};

export default ConnectorButton;
