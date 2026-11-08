import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AccountMenu, useAccountSession, type AccountSignIn } from '@physbox-io/ui';
import { getStoredUser, clearStoredAuth, loginWithGoogle, fetchCurrentUser, type PhysBoxUser } from '../utils/apiClient';
import { renderGoogleSignInButton, isGoogleSignInConfigured, disableGoogleAutoSelect } from '../utils/googleAuth';
import { pullCloudState } from '../utils/cloudSync';
import { setMachineJobProbe, useStore } from '../store/useStore';
import { webSerialManager } from '../utils/webSerialManager';
import { RemoteMachiningModal } from './RemoteMachiningModal';
import { JobHistoryModal } from './JobHistoryModal';
import { CloudSaveStatus } from './CloudSaveStatus';
import { GuestListModal } from './GuestListModal';

export { SIGN_IN_REQUESTED_EVENT, SIGNED_IN_EVENT } from '@physbox-io/ui';

setMachineJobProbe(() => webSerialManager.isRunning());

async function pullAccount(): Promise<{ parameters: number; items: number }> {
  const { parameters, presets, cncTools } = await pullCloudState();
  if (cncTools) useStore.getState().adoptCncTools(cncTools);
  return { parameters, items: presets.received + presets.sent };
}

export const UserProfileButton: React.FC = () => {
  const { user, sync, refresh } = useAccountSession<PhysBoxUser>({
    storedUser: getStoredUser,
    fetchUser: fetchCurrentUser,
    pull: pullAccount,
    workNoun: 'designs',
  });
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  /** Set by the exchange, read once the menu reports the sign-in. */
  const lastSignInWasAdmin = useRef(false);

  const signIn = useMemo<AccountSignIn>(
    () => ({
      kind: 'google-button',
      configured: isGoogleSignInConfigured(),
      render: renderGoogleSignInButton,
      exchange: async (credential) => {
        const res = await loginWithGoogle(credential);
        lastSignInWasAdmin.current = res.is_admin;
      },
    }),
    []
  );

  const onSignedIn = useCallback(
    async (reason: string | null) => {
      // Somebody sent here to do something (sharing) has it done instead of being
      // told that access is still being activated.
      if (!reason && !lastSignInWasAdmin.current) setShowGuestModal(true);
      await refresh();
    },
    [refresh]
  );

  const onSignOut = useCallback(() => {
    clearStoredAuth();
    // Otherwise Google hands the same account straight back on the next visit.
    disableGoogleAutoSelect();
    void refresh();
  }, [refresh]);

  return (
    <AccountMenu
      user={user}
      accent="indigo"
      workNoun="designs"
      sync={sync}
      signIn={signIn}
      onSignedIn={onSignedIn}
      onSignOut={onSignOut}
      onOpenRemote={() => setShowRemoteModal(true)}
      onOpenHistory={() => setShowHistoryModal(true)}
      onOpenGuestList={() => setShowGuestModal(true)}
    >
      <RemoteMachiningModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />
      <JobHistoryModal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} />
      {/* Mounted here only because this component is always on screen; it portals itself. */}
      <CloudSaveStatus />
      <GuestListModal isOpen={showGuestModal} onClose={() => setShowGuestModal(false)} userEmail={user?.email || ''} />
    </AccountMenu>
  );
};
