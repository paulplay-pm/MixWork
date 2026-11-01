import { configureStore } from '@reduxjs/toolkit';

import { libraryArtifactListener } from './libraryArtifactListener';
import agentReducer from './slices/agentSlice';
import artifactReducer from './slices/artifactSlice';
import asrQuotaReducer from './slices/asrQuotaSlice';
import imReducer from './slices/imSlice';
import kitReducer from './slices/kitSlice';
import mcpAuthReducer from './slices/mcpAuthSlice';
import mcpReducer from './slices/mcpSlice';
import coworkReducer from './slices/mixcworkSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';
import ssoBindingsReducer from './slices/ssoBindingsSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    mcpAuth: mcpAuthReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
    asrQuota: asrQuotaReducer,
    artifact: artifactReducer,
    kit: kitReducer,
    ssoBindings: ssoBindingsReducer,
  },
  middleware: getDefaultMiddleware => (
    getDefaultMiddleware().prepend(libraryArtifactListener.middleware)
  ),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
