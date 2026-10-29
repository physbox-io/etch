import { thaiTileElements, TILE_RELIEF_DEPTH_MM } from './thaiTile';
import type { EtchDocument, EtchElement, LivingHingeSpec, PerforationSpec } from '../types/etch';
import { hingeField, HINGE_LAYER_ID } from '../utils/livingHinge';
import { perforationField, PERFORATION_LAYER_ID } from '../utils/perforation';
import { REGISTRATION_LAYER_ID } from '../utils/registration';
import { ornamentById } from '../utils/ornaments';
import { transformPathD } from '../utils/pathTransform';
import type { Matrix } from '../utils/matrix';

/**
 * Selected organic traced motifs (0..100 viewBox centered at 50,50) adapted from
 * clipArtPaths.ts so presets can compose rich organic illustrations without
 * statically importing the lazy-loaded clipArtPaths chunk.
 */
const ORGANIC_MOTIFS = {
  treeOfLife:
    'M 42.3,7.7 Q 42.3,7.7 41.9,9.2 Q 41.5,10.7 40.1,9.9 Q 38.7,9 38.4,9.4 Q 38,9.8 39.8,10.9 Q 41.6,12 42.1,13.3 Q 42.7,14.7 42.3,15.5 Q 42,16.4 42.8,17.2 Q 43.6,18 43.9,19.9 Q 44.1,21.8 41.4,24.2 Q 38.6,26.6 36.2,22.6 Q 33.7,18.5 33.5,14.9 Q 33.2,11.2 32.8,11.5 Q 32.3,11.8 32.6,15.2 Q 32.8,18.6 29.9,18.2 Q 26.9,17.8 26.3,18 Q 25.7,18.3 28.1,18.6 Q 30.6,18.8 32.5,19.8 Q 34.4,20.8 36,24 Q 37.6,27.2 37.2,29.9 Q 36.7,32.5 35.3,32.5 Q 33.8,32.4 34.5,31.6 Q 35.2,30.7 36,30.4 Q 36.9,30.1 36.6,29.5 Q 36.3,28.8 33.8,30.6 Q 31.3,32.3 28.4,30.6 Q 25.4,28.9 24.5,27.2 Q 23.5,25.4 23.6,23.6 Q 23.7,21.9 24.4,20.6 Q 25,19.3 24.5,19 Q 24.1,18.7 23.2,22 Q 22.4,25.3 19.7,24.3 Q 17,23.3 16.6,23.8 Q 16.1,24.3 19.4,25.3 Q 22.6,26.3 23.2,28.1 Q 23.9,29.9 25.1,30.6 Q 26.2,31.4 26.9,32.8 Q 27.6,34.1 26.2,35.1 Q 24.8,36.2 23.4,38.1 Q 22.1,39.9 21.1,40.2 Q 20.1,40.6 18.4,39.4 Q 16.8,38.3 15.6,35.2 Q 14.4,32.1 14,32.6 Q 13.7,33.1 15,36.1 Q 16.3,39 13.4,39.6 Q 10.5,40.2 10.3,40.6 Q 10.1,41 10.5,41.3 Q 10.8,41.5 12.6,40.8 Q 14.5,40.1 15.8,40.1 Q 17.2,40.1 18,40.6 Q 18.9,41.2 16.5,41.5 Q 14.1,41.8 14,42.2 Q 13.8,42.6 17.1,42 Q 20.4,41.4 21.2,42 Q 21.9,42.5 21.9,43.7 Q 21.9,44.9 20.4,45.3 Q 19,45.7 20.8,46.1 Q 22.6,46.5 22.3,48.4 Q 21.9,50.2 21.3,51 Q 20.7,51.7 18.6,51.9 Q 16.5,52.1 16.8,52.5 Q 17,53 18.4,53.1 Q 19.8,53.3 19.2,54.3 Q 18.6,55.2 17.7,55.7 Q 16.8,56.2 16.9,56.7 Q 17,57.3 19.6,55 Q 22.3,52.7 23.1,53.6 Q 23.9,54.5 23.9,56.2 Q 24,58 24.5,57.6 Q 25.1,57.1 28.6,57.3 Q 32.1,57.5 33.5,56.4 Q 34.8,55.4 36.3,54.9 Q 37.7,54.4 42.4,55 Q 47.1,55.6 47.4,58.1 Q 47.7,60.5 47.2,67 Q 46.7,73.5 40.4,73.8 Q 34.1,74 32.4,75 Q 30.7,76 30,75.1 Q 29.3,74.2 28.7,74.1 Q 28.1,74.1 28.8,75.5 Q 29.5,77 28.8,78.1 Q 28.1,79.2 26.9,79.7 Q 25.6,80.3 23.2,80.1 Q 20.8,79.9 19.3,77.8 Q 17.9,75.8 17.6,76.1 Q 17.4,76.5 18.9,78.6 Q 20.5,80.7 22.5,81.2 Q 24.6,81.6 24.3,82.6 Q 24.1,83.5 25.3,82.5 Q 26.6,81.4 27,83.7 Q 27.4,86 27.8,83.7 Q 28.1,81.4 28.8,80.6 Q 29.5,79.8 30.7,79.6 Q 31.9,79.4 35.2,80.6 Q 38.5,81.9 38,83.1 Q 37.6,84.4 36.6,84.3 Q 35.5,84.1 36.4,85.1 Q 37.3,86.1 36.8,87.9 Q 36.2,89.7 36.5,90.1 Q 36.7,90.5 37.2,90.1 Q 37.7,89.7 39.1,90.5 Q 40.5,91.2 42.3,91 Q 44.2,90.8 42,90.5 Q 39.7,90.2 39.4,89.6 Q 39,89 39.8,87.7 Q 40.5,86.5 42.7,85.7 Q 44.9,84.8 45.7,86.8 Q 46.6,88.8 46.6,90.4 Q 46.6,92 47.2,91.3 Q 47.7,90.7 48.4,91.6 Q 49.1,92.5 49.7,92.5 Q 50.4,92.5 51.6,91.7 Q 52.8,90.8 53.4,91.5 Q 54,92.2 54.3,89 Q 54.6,85.8 55.1,85.2 Q 55.7,84.7 59,85.1 Q 62.4,85.5 63.4,87.9 Q 64.4,90.3 65.2,89.8 Q 66,89.2 64.5,86.3 Q 63,83.3 64.1,81.7 Q 65.1,80.1 66.9,79 Q 68.6,78 70.6,78.9 Q 72.5,79.9 72.9,80.8 Q 73.3,81.8 73.2,83.8 Q 73,85.8 73.6,85.3 Q 74.1,84.8 74.5,83.1 Q 74.8,81.4 77.4,80.7 Q 80,80 81.3,77.5 Q 82.6,74.9 81.1,77.1 Q 79.6,79.2 78.5,79.5 Q 77.4,79.7 75.7,78.4 Q 74.1,77.2 75.7,76.2 Q 77.2,75.3 77.2,74.9 Q 77.1,74.5 75.2,75.5 Q 73.3,76.6 72.3,76.6 Q 71.3,76.7 70.1,76.2 Q 68.9,75.7 68.6,74.8 Q 68.4,74 67.9,74.4 Q 67.4,74.9 66.6,74.4 Q 65.8,74 59.7,73.9 Q 53.5,73.9 52.9,67.7 Q 52.3,61.5 52.5,58.8 Q 52.8,56.1 54,55.6 Q 55.3,55 59,54.9 Q 62.7,54.7 64.3,56.2 Q 65.8,57.6 66.6,57.7 Q 67.4,57.8 67.6,57.3 Q 67.8,56.8 66.6,55.7 Q 65.4,54.5 68,53.1 Q 70.7,51.7 72.3,53.1 Q 73.9,54.4 74.1,55.8 Q 74.3,57.2 74.8,57 Q 75.4,56.8 75.3,56 Q 75.1,55.1 79.6,55.5 Q 84.1,55.9 83.9,55.1 Q 83.7,54.3 80.9,54.6 Q 78,54.8 79.3,52.5 Q 80.5,50.1 80.2,49.2 Q 79.8,48.3 82.7,48.8 Q 85.5,49.3 85.8,48.8 Q 86.1,48.3 82.9,47.6 Q 79.6,46.9 78.3,45.2 Q 77,43.4 76.9,42.5 Q 76.7,41.5 77,41.2 Q 77.4,41 80.9,42.1 Q 84.5,43.2 84.3,42.6 Q 84.2,42.1 82.5,42 Q 80.8,41.9 79.1,40.9 Q 77.4,39.9 79.4,38.8 Q 81.5,37.7 84.2,38.6 Q 86.9,39.5 87.2,39 Q 87.6,38.4 84.8,37.5 Q 82,36.6 82.9,34.3 Q 83.9,31.9 83.7,31.5 Q 83.5,31.2 83,31.3 Q 82.5,31.5 81.7,34.2 Q 80.9,36.9 78.8,38 Q 76.6,39.2 75.5,37.6 Q 74.3,35.9 75.9,35.2 Q 77.6,34.4 77.7,33.9 Q 77.9,33.4 77.3,33.3 Q 76.7,33.2 75.2,34.1 Q 73.7,35.1 72.4,33.9 Q 71,32.8 71,32.3 Q 71,31.8 72.6,30.6 Q 74.2,29.4 75.5,27.8 Q 76.8,26.1 80.2,24.9 Q 83.6,23.6 83.1,23.2 Q 82.7,22.7 79.8,23.5 Q 76.9,24.4 76.8,23.2 Q 76.6,21.9 77.6,22.3 Q 78.6,22.7 78.9,22.1 Q 79.2,21.6 77.7,21.1 Q 76.1,20.7 75.6,19.4 Q 75.1,18.1 74.6,18.4 Q 74,18.7 74.4,19.6 Q 74.9,20.4 73.6,20.2 Q 72.4,20 72.6,16.8 Q 72.8,13.6 72.3,13.8 Q 71.9,14 71.4,17.1 Q 71,20.3 67.8,23.8 Q 64.6,27.2 61.2,25 Q 57.8,22.9 57.5,22.3 Q 57.1,21.6 57.7,20.1 Q 58.3,18.7 59.3,18.6 Q 60.3,18.4 59.8,17.8 Q 59.3,17.2 59.9,16.6 Q 60.5,16 62.4,15.9 Q 64.3,15.7 66.1,16.3 Q 67.8,16.9 67.6,16.3 Q 67.4,15.8 64.6,15.1 Q 61.9,14.5 61.8,11.7 Q 61.6,8.9 61.1,9.1 Q 60.7,9.3 60.6,12 Q 60.6,14.6 59.9,15.5 Q 59.1,16.5 56.3,16 Q 53.5,15.5 54.2,12.3 Q 54.9,9.2 54.5,8.8 Q 54,8.3 53.3,11.9 Q 52.6,15.5 50.3,16.8 Q 48.1,18.2 48.1,16.8 Q 48.1,15.4 47.7,15.1 Q 47.4,14.8 47.2,16.6 Q 47,18.3 46.6,18.6 Q 46.2,18.9 45.3,18.2 Q 44.4,17.5 43.5,15 Q 42.5,12.4 43.1,10.4 Q 43.7,8.3 43,8 Q 42.3,7.7 42.3,7.7 Z M 52.3,16.3 Q 52.3,16.3 53.5,16.5 Q 54.6,16.6 55.3,18.5 Q 55.9,20.5 55.7,21.4 Q 55.5,22.4 51.6,21.1 Q 47.7,19.7 50,18 Q 52.3,16.3 52.3,16.3 Z M 47.3,20.7 Q 47.3,20.7 49.4,21 Q 51.5,21.3 53,22.3 Q 54.5,23.3 53.3,23.5 Q 52.1,23.6 49.6,22.8 Q 47.1,22 47.2,21.3 Q 47.3,20.7 47.3,20.7 Z M 71.3,21 Q 71.3,21 73.4,21.3 Q 75.5,21.5 75.6,24 Q 75.7,26.4 72.9,28.9 Q 70.2,31.4 69.2,31.5 Q 68.3,31.6 67.6,30.8 Q 66.9,30 66.9,30.9 Q 66.8,31.9 66.3,31.9 Q 65.9,31.9 65.7,30.1 Q 65.5,28.3 68.4,24.7 Q 71.3,21 71.3,21 Z M 45.3,22.7 Q 45.3,22.7 48.4,23.3 Q 51.6,24 50.8,24.3 Q 50.1,24.6 50.4,25.3 Q 50.6,26 52.9,25.1 Q 55.2,24.2 55.7,25.3 Q 56.2,26.4 56.1,30.9 Q 55.9,35.4 53.1,41.2 Q 50.2,47 47.3,41.2 Q 44.4,35.3 44.2,30.9 Q 44.1,26.6 44.7,24.6 Q 45.3,22.7 45.3,22.7 Z M 56.7,23.7 Q 56.7,23.7 58.4,24.2 Q 60.1,24.6 61.6,25.9 Q 63.1,27.1 63.7,28.2 Q 64.2,29.3 64.2,30.7 Q 64.2,32.2 61,33.1 Q 57.9,34 57.3,28.8 Q 56.7,23.7 56.7,23.7 Z M 42.3,24.3 Q 42.3,24.3 42.7,25.3 Q 43,26.2 42.6,30.4 Q 42.1,34.5 40.4,33.9 Q 38.7,33.3 38.5,32.3 Q 38.3,31.4 38.8,29.3 Q 39.3,27.2 40.8,25.8 Q 42.3,24.3 42.3,24.3 Z M 67.7,32.7 Q 67.7,32.7 68.8,34.5 Q 69.9,36.4 69.9,37.9 Q 69.9,39.4 66.6,39.2 Q 63.3,39 64.2,36.4 Q 65.1,33.9 66.4,33.3 Q 67.7,32.7 67.7,32.7 Z M 69,32.7 Q 69,32.7 70.7,33.9 Q 72.4,35.1 72.4,35.8 Q 72.4,36.5 71.7,36.8 Q 71,37.1 70,34.9 Q 69,32.7 69,32.7 Z M 32.7,33.3 Q 32.7,33.3 34.7,33.8 Q 36.7,34.4 37,36.9 Q 37.2,39.4 34.5,39.4 Q 31.8,39.5 31.4,37.8 Q 31,36.1 31.8,34.7 Q 32.7,33.3 32.7,33.3 Z M 63,33.7 Q 63,33.7 63.3,33.9 Q 63.6,34.2 62.3,37 Q 60.9,39.7 57,43 Q 53,46.4 55,41.6 Q 57.1,36.9 60,35.3 Q 63,33.7 63,33.7 Z M 28.3,34.3 Q 28.3,34.3 29.2,35.5 Q 30,36.7 30.1,38.3 Q 30.1,39.9 29.3,40 Q 28.4,40.1 28.7,39.2 Q 29,38.3 28.5,38 Q 28,37.8 27.6,39.4 Q 27.2,41 25,41 Q 22.8,41 23.3,39.9 Q 23.7,38.7 26,36.5 Q 28.3,34.3 28.3,34.3 Z M 38.3,34.7 Q 38.3,34.7 40,35.2 Q 41.6,35.7 42.8,36.7 Q 43.9,37.7 45.7,42.6 Q 47.5,47.5 43.4,43.9 Q 39.3,40.2 38.8,37.4 Q 38.3,34.7 38.3,34.7 Z M 73,36.7 Q 73,36.7 73.5,36.7 Q 73.9,36.8 74.8,38.2 Q 75.6,39.6 73.4,39.6 Q 71.2,39.6 72.1,38.1 Q 73,36.7 73,36.7 Z M 65,40.7 Q 65,40.7 67,40.8 Q 69,41 67,43.7 Q 64.9,46.4 59.2,48.5 Q 53.5,50.6 56.5,46.7 Q 59.5,42.8 60.8,42 Q 62,41.2 63.5,40.9 Q 65,40.7 65,40.7 Z M 70.3,40.7 Q 70.3,40.7 71.9,41 Q 73.5,41.2 74,42 Q 74.6,42.8 73.9,45.3 Q 73.2,47.7 72.1,48.9 Q 71,50.2 68.5,48.8 Q 66,47.3 68.2,44 Q 70.3,40.7 70.3,40.7 Z M 32.7,41 Q 32.7,41 35.8,41.6 Q 39,42.1 40.7,43.6 Q 42.4,45.1 44.3,47.6 Q 46.2,50.2 41,48.3 Q 35.8,46.4 34.2,43.7 Q 32.7,41 32.7,41 Z M 29,41.3 Q 29,41.3 30.2,41.6 Q 31.4,41.8 32.7,44.4 Q 33.9,47.1 32,47.8 Q 30.1,48.5 29.4,48.1 Q 28.8,47.8 28.4,45.6 Q 28,43.5 28.5,42.4 Q 29,41.3 29,41.3 Z M 22.7,42 Q 22.7,42 23.8,42.3 Q 25,42.6 24.2,44 Q 23.4,45.3 23,43.7 Q 22.7,42 22.7,42 Z M 27,42 Q 27,42 27.1,44.1 Q 27.3,46.1 25.9,45.8 Q 24.4,45.6 25.7,43.8 Q 27,42 27,42 Z M 75.3,43.3 Q 75.3,43.3 75.5,44.9 Q 75.6,46.5 75.4,47.5 Q 75.1,48.5 74.5,48.7 Q 74,48.9 74.6,46.1 Q 75.3,43.3 75.3,43.3 Z M 76.7,44.7 Q 76.7,44.7 77.7,46 Q 78.8,47.3 78.7,48.2 Q 78.6,49 77.4,48.8 Q 76.2,48.6 76.4,46.6 Q 76.7,44.7 76.7,44.7 Z M 23.7,46.3 Q 23.7,46.3 25.4,46.8 Q 27,47.2 27.8,48.2 Q 28.6,49.2 26.9,50.3 Q 25.3,51.4 24.1,51.5 Q 23,51.7 22.7,51.3 Q 22.4,51 23.2,49.5 Q 24.1,48.1 23.9,47.2 Q 23.7,46.3 23.7,46.3 Z M 34,48.3 Q 34,48.3 36.7,48.8 Q 39.5,49.3 42.6,51.1 Q 45.7,52.9 40.5,52.7 Q 35.4,52.6 33.2,51.2 Q 31,49.8 32.5,49.1 Q 34,48.3 34,48.3 Z M 63.3,48.7 Q 63.3,48.7 66.4,49.7 Q 69.4,50.7 68.8,51.3 Q 68.2,51.9 66.2,52.6 Q 64.2,53.3 59.2,53.1 Q 54.3,52.8 58.8,50.8 Q 63.3,48.7 63.3,48.7 Z M 73,49.7 Q 73,49.7 75.9,49.9 Q 78.9,50.1 78.2,52.3 Q 77.5,54.5 76.1,54.2 Q 74.8,53.9 73.5,52.8 Q 72.3,51.6 72.7,50.7 Q 73,49.7 73,49.7 Z M 29,50 Q 29,50 31.7,52 Q 34.4,53.9 32.8,55.2 Q 31.2,56.4 29.8,56.7 Q 28.4,56.9 27,56.1 Q 25.6,55.3 25.3,54.6 Q 25,54 25.4,53 Q 25.8,52.1 27.4,51 Q 29,50 29,50 Z M 35.3,76 Q 35.3,76 40,76.7 Q 44.7,77.3 42.8,78.6 Q 40.9,79.8 39.1,79.9 Q 37.3,79.9 34.8,79.1 Q 32.3,78.2 33.8,77.1 Q 35.3,76 35.3,76 Z M 63.3,76 Q 63.3,76 65.1,76.7 Q 66.8,77.4 64.4,78.6 Q 62.1,79.7 60.9,79.8 Q 59.7,79.9 57.5,78.6 Q 55.3,77.4 59.3,76.7 Q 63.3,76 63.3,76 Z M 47,79 Q 47,79 46,81.1 Q 45,83.3 43.5,84.1 Q 41.9,85 40.7,85 Q 39.4,85.1 40.1,83.5 Q 40.8,81.9 43.9,80.5 Q 47,79 47,79 Z M 49.7,79 Q 49.7,79 51.1,81 Q 52.5,83 52.9,84.3 Q 53.2,85.6 53,87.8 Q 52.8,89.9 51.5,90.6 Q 50.2,91.3 49.1,90.4 Q 48,89.5 47.5,88 Q 47,86.4 47.1,84.9 Q 47.3,83.4 48.5,81.2 Q 49.7,79 49.7,79 Z M 52.7,79 Q 52.7,79 56,80.4 Q 59.3,81.8 60.1,82.8 Q 60.8,83.7 57.7,83.3 Q 54.6,82.9 53.6,80.9 Q 52.7,79 52.7,79 Z M95.5 50 A45.5 45.5 0 1 0 4.5 50 A45.5 45.5 0 1 0 95.5 50 Z M94.3 50 A44.3 44.3 0 1 0 5.7 50 A44.3 44.3 0 1 0 94.3 50 Z',
  lotusBloom:
    'M 50 92 L 46.8 91.5 L 40.7 90.1 L 37.9 89.4 L 32.4 87.6 L 27.5 85.6 L 25.2 84.4 L 20.9 82 L 17.2 79.4 L 13.9 76.6 L 12.5 75.1 L 11.2 73.6 L 10.1 72 L 9 70.4 L 8.1 68.8 L 7.4 67.1 L 6.8 65.5 L 6.3 63.7 L 6 62 L 8.2 61.8 L 10.5 61.8 L 12.7 62 M 12.7 62 L 15 62.3 L 17.2 62.7 L 20.5 63.7 M 91.8 61.8 L 94 62 L 93.7 63.7 L 93.2 65.5 L 92.6 67.1 L 91.9 68.8 L 91 70.4 L 89.9 72 L 88.8 73.6 L 87.5 75.1 L 86.1 76.6 L 82.8 79.4 L 81 80.8 L 77 83.3 L 74.8 84.4 L 72.5 85.6 L 67.6 87.6 L 62.1 89.4 L 59.3 90.1 L 53.2 91.5 L 50 92 M 79.5 63.7 L 82.8 62.7 L 85 62.3 L 87.3 62 L 89.5 61.8 L 91.8 61.8 M 50 92 L 47.5 91.4 L 45.2 90.8 L 42.9 90 L 40.7 89 L 38.6 88 L 36.6 86.9 L 34.7 85.6 L 32.9 84.3 L 31.2 82.9 L 29.6 81.3 L 28.1 79.7 L 26.8 78 L 25.5 76.2 L 24.4 74.3 L 23.3 72.4 L 22.4 70.4 L 21.7 68.3 L 21 66.1 L 20.5 63.9 L 20.1 61.6 L 19.9 59.3 L 19.8 56.9 L 19.8 54.5 L 20 52 L 22.5 52.6 M 22.5 52.6 L 24.8 53.2 L 27.1 54 L 29.3 55 L 31.4 56 L 33.4 57.1 L 35.3 58.4 L 37.1 59.7 L 39.2 61.5 M 80.2 54.5 L 80.2 56.9 L 80.1 59.3 L 79.9 61.6 L 79.5 63.9 L 79 66.1 L 78.3 68.3 L 77.6 70.4 L 76.7 72.4 L 75.6 74.3 L 74.5 76.2 L 73.3 78 L 71.9 79.7 L 70.4 81.3 L 68.8 82.9 L 67.1 84.3 L 65.3 85.6 L 63.4 86.9 L 61.4 88 L 59.3 89 L 57.1 90 L 54.8 90.8 L 52.5 91.4 L 50 92 M 60.8 61.5 L 62.9 59.7 L 64.7 58.4 L 66.6 57.1 L 68.6 56 L 70.7 55 L 72.9 54 L 75.2 53.2 L 77.5 52.6 L 80 52 L 80.2 54.5 M 51.9 42.3 L 53.6 44.5 L 55.2 46.8 L 56.5 49.1 L 57.7 51.4 L 58.7 53.8 L 59.6 56.1 L 60.2 58.4 L 60.7 60.7 L 61.1 63 L 61.2 65.2 L 61.3 67.5 L 61.1 69.7 L 60.8 72 L 60.4 74.1 L 59.8 76.3 L 59 78.4 L 58.2 80.5 L 57.1 82.5 L 56 84.5 L 54.7 86.5 L 53.2 88.4 L 51.7 90.2 L 50 92 L 48.3 90.2 L 46.8 88.4 L 45.3 86.5 L 44 84.5 L 42.9 82.5 L 41.8 80.5 L 41 78.4 L 40.2 76.3 L 39.6 74.1 L 39.2 72 L 38.9 69.7 L 38.8 67.5 L 38.8 65.2 L 38.9 63 L 39.3 60.7 L 39.8 58.4 L 40.4 56.1 L 41.3 53.8 L 42.3 51.4 L 43.5 49.1 L 44.8 46.8 L 46.4 44.5 L 48.1 42.3 L 50 40 Z',
  fleurDeLis:
    'M 46 51.2 L 44.3 49.2 L 41.6 46.7 L 39.7 45.3 L 37.6 44.1 L 35.5 43.2 L 33.4 42.6 L 31.3 42.3 L 29.1 42.4 L 27 43 L 26 43.4 L 24.2 44.5 L 22.8 45.7 L 22.3 46.4 L 21.6 47.8 L 21.2 49.3 L 21.2 50.8 L 21.5 52.4 L 22.2 53.9 L 23.1 55.4 L 23.8 56.1 L 25.2 57.4 L 26.9 58.6 L 28.9 59.6 L 30 60 L 28.5 60.4 L 27 60.7 L 25.6 60.9 L 24.2 60.9 L 22.8 60.8 L 21.4 60.6 L 20.1 60.2 L 17.7 59.2 L 15.6 57.8 L 14.6 57 L 13.8 56.1 L 13 55.1 L 12.3 54 L 11.8 52.9 L 11.3 51.7 L 11 50.4 L 10.8 49.1 L 10.8 47.8 L 10.8 46.4 L 11.1 45 L 11.5 43.5 L 12 42 L 12.8 40.3 L 13.7 38.8 L 14.8 37.4 L 15.9 36.2 L 17.2 35.1 L 18.5 34.2 L 19.9 33.4 L 21.3 32.7 L 22.9 32.3 L 24.4 31.9 L 26.1 31.8 L 27.8 31.8 L 29.5 31.9 M 29.5 31.9 L 31.2 32.2 L 32.9 32.6 L 34.7 33.3 L 36.4 34 L 38.2 35 L 39.9 36.1 L 42 37.6 M 73.9 31.8 L 75.6 31.9 L 77.1 32.3 L 78.7 32.7 L 80.1 33.4 L 81.5 34.2 L 82.9 35.1 L 84.1 36.2 L 85.2 37.4 L 86.3 38.8 L 87.2 40.3 L 88 42 L 88.5 43.5 L 88.9 45 L 89.2 46.4 L 89.2 47.8 L 89.2 49.1 L 89 50.4 L 88.7 51.7 L 88.2 52.9 L 87.7 54 L 87 55.1 L 86.2 56.1 L 85.4 57 L 84.4 57.8 L 82.3 59.2 L 79.9 60.2 L 78.6 60.6 L 77.2 60.8 L 75.8 60.9 L 74.4 60.9 L 73 60.7 L 71.5 60.4 L 70 60 L 71.1 59.6 L 73.1 58.6 L 74.8 57.4 L 76.2 56.1 L 76.9 55.4 L 77.8 53.9 L 78.5 52.4 L 78.8 50.8 L 78.8 49.3 L 78.4 47.8 L 77.7 46.4 L 77.2 45.7 L 75.8 44.5 L 74 43.4 L 73 43 L 70.9 42.4 L 68.7 42.3 L 66.6 42.6 L 64.5 43.2 L 62.4 44.1 L 60.3 45.3 L 58.4 46.7 L 55.7 49.2 L 54 51.2 M 58 37.6 L 60.1 36.1 L 61.8 35 L 63.6 34 L 65.3 33.3 L 67.1 32.6 L 68.8 32.2 L 70.5 31.9 L 72.3 31.8 L 73.9 31.8 M 46 83.2 L 46 66 M 54 66 L 54 83.2 M 46 56 L 46 48 L 45.1 46.2 L 43.5 42.7 L 42.8 40.9 L 41.8 37.2 L 41.5 35.3 L 41.1 31.6 L 41.1 29.7 L 41.3 26 L 41.8 22.3 L 42.7 18.5 L 44 14.8 L 45.7 11.1 L 47.7 7.5 L 50 4 L 51.2 5.8 M 51.2 5.8 L 52.3 7.5 L 54.3 11.1 L 56 14.8 L 56.7 16.7 L 57.8 20.4 L 58.2 22.3 L 58.8 26 L 58.9 27.9 L 58.9 31.6 L 58.7 33.5 L 58.5 35.3 L 57.7 39 L 56.5 42.7 L 55.8 44.5 L 54 48 L 54 56 M 70 66 L 30 66 L 30 56 L 70 56 Z M 51.5 83 L 55.9 83.3 L 60.1 84 L 63.8 85.1 L 66 86 L 66 94 L 34 94 L 34 86 L 36.2 85.1 L 37.3 84.7 L 41.3 83.8 L 45.5 83.2 L 50 83 Z',
  scrollFlourish:
    'M50 26 C50 42 42 52 28 58 C14 64 4 56 8 44 C11 35 24 34 28 44 C31 51 25 56 20 53 M50 26 C50 42 58 52 72 58 C86 64 96 56 92 44 C89 35 76 34 72 44 C69 51 75 56 80 53 M50 26 C44 18 44 10 50 4 C56 10 56 18 50 26 Z M50 26 V74 M50 74 C42 78 38 86 40 94 C46 92 50 86 50 78 M50 74 C58 78 62 86 60 94 C54 92 50 86 50 78',
  compassRose:
    'M50 4 L57.1 42.9 L96 50 L57.1 57.1 L50 96 L42.9 57.1 L4 50 L42.9 42.9 Z M71.2 28.8 L59 50 L71.2 71.2 L50 59 L28.8 71.2 L41 50 L28.8 28.8 L50 41 Z M58 50 A8 8 0 1 0 42 50 A8 8 0 1 0 58 50 Z',
  gullBirds:
    'M10 40 C22 24 34 24 44 40 C54 24 66 24 78 40 M40 70 C48 60 56 60 62 70 C68 60 76 60 84 70',
  pineTree:
    'M50 6 L34 34 H42 L26 58 H38 L20 80 H80 L62 58 H74 L58 34 H66 Z M44 80 V94 H56 V80',
} as const;

/** Places a 0..100 motif centered at (cx, cy) with size (w, h), optional rotation (deg) and mirror flips. */
function placeArt(
  d: string,
  cx: number,
  cy: number,
  w: number,
  h: number = w,
  rotDeg = 0,
  flipX: 1 | -1 = 1,
  flipY: 1 | -1 = 1
): string {
  const sx = (w / 100) * flipX;
  const sy = (h / 100) * flipY;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = sx * cos;
  const b = sx * sin;
  const c = -sy * sin;
  const dm = sy * cos;
  const e = cx - 50 * a - 50 * c;
  const f = cy - 50 * b - 50 * dm;
  const m: Matrix = [a, b, c, dm, e, f];
  return transformPathD(d, m, 2);
}

export interface EtchPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  doc: EtchDocument;
}

function generateIntricateMandalaElements(cx: number = 150, cy: number = 100): EtchElement[] {
  const elements: EtchElement[] = [];

  // 1. Top Wall Mount Hole (Cut)
  elements.push({
    id: 'mandala_mount_hole',
    name: 'Wall Mount Hole',
    type: 'circle',
    layerId: 'cut',
    x: cx,
    y: 12,
    r: 2.5,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  // 2. Medallion Outer Cut Boundary (184mm diameter)
  elements.push({
    id: 'mandala_outer_cut',
    name: 'Medallion Outer Cut Boundary',
    type: 'circle',
    layerId: 'cut',
    x: cx,
    y: cy,
    r: 92,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  // 3. Outer Concentric Etch Rings (88mm, 85mm, 82mm)
  elements.push({
    id: 'ring_outer_88',
    name: 'Outer Border Ring (88mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 88,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_outer_85',
    name: 'Dashed Accent Ring (85mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 85,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dashed', strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_outer_82',
    name: 'Outer Border Ring (82mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 82,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 4. 24-Point Outer Starburst Rays
  elements.push({
    id: 'starburst_24',
    name: '24-Point Outer Starburst Rays',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 24, innerRadius: 70, outerRadius: 82,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 5. Mid Boundary Ring (70mm)
  elements.push({
    id: 'ring_mid_70',
    name: 'Mid Boundary Ring (70mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 70,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 6. 16-Fold Outer Lotus Petals & Inner Filigree
  const petals16Count = 16;
  const angleStep16 = (2 * Math.PI) / petals16Count;
  for (let i = 0; i < petals16Count; i++) {
    const startA = i * angleStep16;
    const midA = startA + angleStep16 / 2;
    const endA = (i + 1) * angleStep16;

    const p1x = cx + 48 * Math.cos(startA);
    const p1y = cy + 48 * Math.sin(startA);
    const tipX = cx + 70 * Math.cos(midA);
    const tipY = cy + 70 * Math.sin(midA);
    const p2x = cx + 48 * Math.cos(endA);
    const p2y = cy + 48 * Math.sin(endA);

    const c1x = cx + 64 * Math.cos(startA + angleStep16 * 0.25);
    const c1y = cy + 64 * Math.sin(startA + angleStep16 * 0.25);
    const c2x = cx + 64 * Math.cos(endA - angleStep16 * 0.25);
    const c2y = cy + 64 * Math.sin(endA - angleStep16 * 0.25);

    const dOuter = `M ${p1x.toFixed(2)} ${p1y.toFixed(2)} Q ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${tipX.toFixed(2)} ${tipY.toFixed(2)} Q ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2x.toFixed(2)} ${p2y.toFixed(2)}`;

    elements.push({
      id: `outer_petal_${i}`,
      name: `Outer Lotus Petal ${i + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
      d: dOuter, visible: true, locked: false
    });

    // Inner Teardrop Filigree inside each petal
    const fp1x = cx + 52 * Math.cos(startA + angleStep16 * 0.15);
    const fp1y = cy + 52 * Math.sin(startA + angleStep16 * 0.15);
    const ftipX = cx + 64 * Math.cos(midA);
    const ftipY = cy + 64 * Math.sin(midA);
    const fp2x = cx + 52 * Math.cos(endA - angleStep16 * 0.15);
    const fp2y = cy + 52 * Math.sin(endA - angleStep16 * 0.15);

    const fc1x = cx + 60 * Math.cos(startA + angleStep16 * 0.3);
    const fc1y = cy + 60 * Math.sin(startA + angleStep16 * 0.3);
    const fc2x = cx + 60 * Math.cos(endA - angleStep16 * 0.3);
    const fc2y = cy + 60 * Math.sin(endA - angleStep16 * 0.3);

    const dInner = `M ${fp1x.toFixed(2)} ${fp1y.toFixed(2)} Q ${fc1x.toFixed(2)} ${fc1y.toFixed(2)} ${ftipX.toFixed(2)} ${ftipY.toFixed(2)} Q ${fc2x.toFixed(2)} ${fc2y.toFixed(2)} ${fp2x.toFixed(2)} ${fp2y.toFixed(2)}`;

    elements.push({
      id: `petal_filigree_${i}`,
      name: `Petal Filigree ${i + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
      d: dInner, visible: true, locked: false
    });
  }

  // 7. Base Petal Ring (48mm) & Dotted Ring (45mm)
  elements.push({
    id: 'ring_inner_48',
    name: 'Petal Base Ring (48mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 48,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'ring_inner_45',
    name: 'Dotted Accent Ring (45mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 45,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dotted', strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 8. 12-Point Interlocking Sacred Stars
  elements.push({
    id: 'star_12_a',
    name: '12-Point Interlocking Star A',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 12, innerRadius: 32, outerRadius: 45,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'star_12_b',
    name: '12-Point Interlocking Star B',
    type: 'star', layerId: 'etch',
    x: cx, y: cy, pointsCount: 12, innerRadius: 32, outerRadius: 45,
    rotation: 15, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 9. Inner Boundary Ring (32mm)
  elements.push({
    id: 'ring_inner_32',
    name: 'Inner Boundary Ring (32mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 32,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 10. 8-Fold Inner Lotus Blossom
  const petals8Count = 8;
  const angleStep8 = (2 * Math.PI) / petals8Count;
  for (let j = 0; j < petals8Count; j++) {
    const startA = j * angleStep8;
    const midA = startA + angleStep8 / 2;
    const endA = (j + 1) * angleStep8;

    const ip1x = cx + 18 * Math.cos(startA);
    const ip1y = cy + 18 * Math.sin(startA);
    const itipX = cx + 32 * Math.cos(midA);
    const itipY = cy + 32 * Math.sin(midA);
    const ip2x = cx + 18 * Math.cos(endA);
    const ip2y = cy + 18 * Math.sin(endA);

    const ic1x = cx + 28 * Math.cos(startA + angleStep8 * 0.25);
    const ic1y = cy + 28 * Math.sin(startA + angleStep8 * 0.25);
    const ic2x = cx + 28 * Math.cos(endA - angleStep8 * 0.25);
    const ic2y = cy + 28 * Math.sin(endA - angleStep8 * 0.25);

    const dInnerPetal = `M ${ip1x.toFixed(2)} ${ip1y.toFixed(2)} Q ${ic1x.toFixed(2)} ${ic1y.toFixed(2)} ${itipX.toFixed(2)} ${itipY.toFixed(2)} Q ${ic2x.toFixed(2)} ${ic2y.toFixed(2)} ${ip2x.toFixed(2)} ${ip2y.toFixed(2)}`;

    elements.push({
      id: `inner_petal_${j}`,
      name: `Inner Lotus Petal ${j + 1}`,
      type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
      d: dInnerPetal, visible: true, locked: false
    });
  }

  // 11. Core Ring (18mm)
  elements.push({
    id: 'ring_core_18',
    name: 'Core Ring (18mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 18,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });

  // 12. Hatched Lotus Medallion (Fill Layer)
  elements.push({
    id: 'mandala_core_star',
    name: 'Hatched Lotus Medallion',
    type: 'star', layerId: 'fill',
    x: cx, y: cy, pointsCount: 8, innerRadius: 7, outerRadius: 16,
    rotation: 22.5, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: '#10b981', fillColor: '#10b981',
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.6, hatchOutline: true,
    visible: true, locked: false
  });

  // 13. Center Eyepiece Ring (6mm) & Center Cut Hole (1.5mm)
  elements.push({
    id: 'ring_core_6',
    name: 'Core Eyepiece Ring (6mm)',
    type: 'circle', layerId: 'etch',
    x: cx, y: cy, r: 6,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none',
    visible: true, locked: false
  });
  elements.push({
    id: 'mandala_center_hole',
    name: 'Center Axis Hole',
    type: 'circle', layerId: 'cut',
    x: cx, y: cy, r: 1.5,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none',
    visible: true, locked: false
  });

  return elements;
}

function generateCyberpunkBadgeElements(cx: number = 150, cy: number = 100): EtchElement[] {
  const elements: EtchElement[] = [];

  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';

  // 1. Cut Layer Elements
  // Outer Sci-Fi Shield Contour with chamfers and side heat-sink fins
  const dShield = `M ${cx - 20} ${cy - 65} L ${cx + 20} ${cy - 65} L ${cx + 55} ${cy - 45} L ${cx + 55} ${cy - 15} L ${cx + 60} ${cy - 15} L ${cx + 60} ${cy - 10} L ${cx + 55} ${cy - 10} L ${cx + 55} ${cy + 15} L ${cx + 60} ${cy + 15} L ${cx + 60} ${cy + 20} L ${cx + 55} ${cy + 20} L ${cx + 55} ${cy + 40} L ${cx + 20} ${cy + 65} L ${cx - 20} ${cy + 65} L ${cx - 55} ${cy + 40} L ${cx - 55} ${cy + 20} L ${cx - 60} ${cy + 20} L ${cx - 60} ${cy + 15} L ${cx - 55} ${cy + 15} L ${cx - 55} ${cy - 10} L ${cx - 60} ${cy - 10} L ${cx - 60} ${cy - 15} L ${cx - 55} ${cy - 15} L ${cx - 55} ${cy - 45} Z`;

  elements.push({
    id: 'cyber_shield_cut',
    name: 'Sci-Fi Shield Outer Cut Boundary',
    type: 'path', layerId: 'cut',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
    d: dShield, visible: true, locked: false
  });

  // Top Lanyard Mounting Slot (24x4mm slot)
  elements.push({
    id: 'cyber_lanyard_slot',
    name: 'Top Lanyard Mounting Slot',
    type: 'rect', layerId: 'cut',
    x: cx - 12, y: cy - 58, w: 24, h: 4, rx: 2, ry: 2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
    visible: true, locked: false
  });

  // 4x Corner M3 Mounting Screw Holes
  const cornerHoles = [
    { id: 'hole_top_left', name: 'Top-Left Mount Hole', x: cx - 42, y: cy - 38 },
    { id: 'hole_top_right', name: 'Top-Right Mount Hole', x: cx + 42, y: cy - 38 },
    { id: 'hole_bot_left', name: 'Bottom-Left Mount Hole', x: cx - 42, y: cy + 38 },
    { id: 'hole_bot_right', name: 'Bottom-Right Mount Hole', x: cx + 42, y: cy + 38 },
  ];
  cornerHoles.forEach(h => {
    elements.push({
      id: h.id, name: h.name, type: 'circle', layerId: 'cut',
      x: h.x, y: h.y, r: 1.6, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.2, strokeColor: cutColor, fillColor: 'none',
      visible: true, locked: false
    });
  });

  // 2. Fill Layer Elements (Raster Pocket Fills)
  // Central IC Chip Pocket Base (Hatched 45 deg)
  elements.push({
    id: 'cyber_ic_pocket_fill',
    name: 'Processor Core Pocket Fill',
    type: 'rect', layerId: 'fill',
    x: cx - 18, y: cy - 18, w: 36, h: 36, rx: 3, ry: 3,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.5, hatchOutline: true,
    visible: true, locked: false
  });

  // Top Header Accent Bar Fill
  elements.push({
    id: 'cyber_header_fill',
    name: 'Top Header Accent Pocket',
    type: 'rect', layerId: 'fill',
    x: cx - 35, y: cy - 50, w: 70, h: 4, rx: 1, ry: 1,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 135, hatchSpacing: 0.8, hatchOutline: true,
    visible: true, locked: false
  });

  // Bottom Status Bar Fill
  elements.push({
    id: 'cyber_footer_fill',
    name: 'Bottom Telemetry Bar Pocket',
    type: 'rect', layerId: 'fill',
    x: cx - 35, y: cy + 48, w: 70, h: 4, rx: 1, ry: 1,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: fillColor, fillColor: fillColor,
    machining: 'filled', hatchAngle: 45, hatchSpacing: 0.8, hatchOutline: true,
    visible: true, locked: false
  });

  // 3. Vector Etch Layer Elements
  // Inner Chamfered Framing Border
  const dInnerFrame = `M ${cx - 17} ${cy - 61} L ${cx + 17} ${cy - 61} L ${cx + 51} ${cy - 42} L ${cx + 51} ${cy + 37} L ${cx + 17} ${cy + 61} L ${cx - 17} ${cy + 61} L ${cx - 51} ${cy + 37} L ${cx - 51} ${cy - 42} Z`;
  elements.push({
    id: 'cyber_inner_frame',
    name: 'Inner Chamfered Border Line',
    type: 'path', layerId: 'etch',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none',
    d: dInnerFrame, visible: true, locked: false
  });

  // Secondary Dashed Accent Border
  const dDashedFrame = `M ${cx - 15} ${cy - 57} L ${cx + 15} ${cy - 57} L ${cx + 47} ${cy - 40} L ${cx + 47} ${cy + 35} L ${cx + 15} ${cy + 57} L ${cx - 15} ${cy + 57} L ${cx - 47} ${cy + 35} L ${cx - 47} ${cy - 40} Z`;
  elements.push({
    id: 'cyber_dashed_frame',
    name: 'Dashed Accent Border Line',
    type: 'path', layerId: 'etch',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeDash: 'dashed', strokeColor: etchColor, fillColor: 'none',
    d: dDashedFrame, visible: true, locked: false
  });

  // Central QFP Microprocessor Chip Package (30x30mm)
  elements.push({
    id: 'cyber_ic_chip',
    name: 'QFP Microprocessor Package Outline',
    type: 'rect', layerId: 'etch',
    x: cx - 15, y: cy - 15, w: 30, h: 30, rx: 2, ry: 2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // IC Pin 1 Notch Indicator Circle
  elements.push({
    id: 'cyber_ic_pin1',
    name: 'IC Pin 1 Orientation Marker',
    type: 'circle', layerId: 'etch',
    x: cx - 11, y: cy - 11, r: 1.2,
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, fillColor: etchColor,
    visible: true, locked: false
  });

  // IC Pin Legs (8 per side = 32 pins) - Using line elements with relative (x2, y2)
  const pinSpacing = 3;
  const pinStart = -10.5;
  for (let i = 0; i < 8; i++) {
    const offset = pinStart + i * pinSpacing;
    // Top pins
    elements.push({
      id: `ic_pin_t_${i}`, name: `IC Pin Top ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + offset, y: cy - 15, x2: 0, y2: -5,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Bottom pins
    elements.push({
      id: `ic_pin_b_${i}`, name: `IC Pin Bottom ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + offset, y: cy + 15, x2: 0, y2: 5,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Left pins
    elements.push({
      id: `ic_pin_l_${i}`, name: `IC Pin Left ${i+1}`, type: 'line', layerId: 'etch',
      x: cx - 15, y: cy + offset, x2: -5, y2: 0,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
    // Right pins
    elements.push({
      id: `ic_pin_r_${i}`, name: `IC Pin Right ${i+1}`, type: 'line', layerId: 'etch',
      x: cx + 15, y: cy + offset, x2: 5, y2: 0,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
    });
  }

  // 45-Degree PCB Circuit Traces with Via Pads
  const traces = [
    { id: 'trace_tl1', d: `M ${cx - 10.5} ${cy - 20} L ${cx - 10.5} ${cy - 28} L ${cx - 25} ${cy - 42.5} L ${cx - 38} ${cy - 42.5}`, via: { x: cx - 38, y: cy - 42.5 } },
    { id: 'trace_tl2', d: `M ${cx - 4.5} ${cy - 20} L ${cx - 4.5} ${cy - 26} L ${cx - 15} ${cy - 36.5} L ${cx - 15} ${cy - 42.5}`, via: { x: cx - 15, y: cy - 42.5 } },
    { id: 'trace_tl3', d: `M ${cx - 20} ${cy - 10.5} L ${cx - 28} ${cy - 10.5} L ${cx - 38} ${cy - 20.5} L ${cx - 38} ${cy - 30}`, via: { x: cx - 38, y: cy - 30 } },

    { id: 'trace_tr1', d: `M ${cx + 10.5} ${cy - 20} L ${cx + 10.5} ${cy - 28} L ${cx + 25} ${cy - 42.5} L ${cx + 38} ${cy - 42.5}`, via: { x: cx + 38, y: cy - 42.5 } },
    { id: 'trace_tr2', d: `M ${cx + 4.5} ${cy - 20} L ${cx + 4.5} ${cy - 26} L ${cx + 15} ${cy - 36.5} L ${cx + 15} ${cy - 42.5}`, via: { x: cx + 15, y: cy - 42.5 } },
    { id: 'trace_tr3', d: `M ${cx + 20} ${cy - 10.5} L ${cx + 28} ${cy - 10.5} L ${cx + 38} ${cy - 20.5} L ${cx + 38} ${cy - 30}`, via: { x: cx + 38, y: cy - 30 } },

    { id: 'trace_bl1', d: `M ${cx - 10.5} ${cy + 20} L ${cx - 10.5} ${cy + 28} L ${cx - 25} ${cy + 42.5} L ${cx - 35} ${cy + 42.5}`, via: { x: cx - 35, y: cy + 42.5 } },
    { id: 'trace_bl2', d: `M ${cx - 20} ${cy + 10.5} L ${cx - 28} ${cy + 10.5} L ${cx - 40} ${cy + 22.5} L ${cx - 40} ${cy + 32}`, via: { x: cx - 40, y: cy + 32 } },

    { id: 'trace_br1', d: `M ${cx + 10.5} ${cy + 20} L ${cx + 10.5} ${cy + 28} L ${cx + 25} ${cy + 42.5} L ${cx + 35} ${cy + 42.5}`, via: { x: cx + 35, y: cy + 42.5 } },
    { id: 'trace_br2', d: `M ${cx + 20} ${cy + 10.5} L ${cx + 28} ${cy + 10.5} L ${cx + 40} ${cy + 22.5} L ${cx + 40} ${cy + 32}`, via: { x: cx + 40, y: cy + 32 } },
  ];

  traces.forEach(t => {
    elements.push({
      id: t.id, name: `PCB Circuit Trace ${t.id}`, type: 'path', layerId: 'etch',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      d: t.d, visible: true, locked: false
    });
    if (t.via) {
      elements.push({
        id: `${t.id}_via`, name: `Via Pad ${t.id}`, type: 'circle', layerId: 'etch',
        x: t.via.x, y: t.via.y, r: 1.0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
        strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
        visible: true, locked: false
      });
    }
  });

  // SMD Resistor / Capacitor Component Pads (0805 Package Style)
  const smdComponents = [
    { id: 'smd_c1', name: 'Capacitor C1 Pads', x: cx - 32, y: cy - 25 },
    { id: 'smd_r1', name: 'Resistor R1 Pads', x: cx + 32, y: cy - 25 },
    { id: 'smd_c2', name: 'Capacitor C2 Pads', x: cx - 32, y: cy + 25 },
    { id: 'smd_r2', name: 'Resistor R2 Pads', x: cx + 32, y: cy + 25 },
  ];
  smdComponents.forEach(s => {
    elements.push({
      id: `${s.id}_p1`, name: `${s.name} Pad 1`, type: 'rect', layerId: 'etch',
      x: s.x - 2, y: s.y - 1, w: 1.5, h: 2, rx: 0.2, ry: 0.2,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      visible: true, locked: false
    });
    elements.push({
      id: `${s.id}_p2`, name: `${s.name} Pad 2`, type: 'rect', layerId: 'etch',
      x: s.x + 0.5, y: s.y - 1, w: 1.5, h: 2, rx: 0.2, ry: 0.2,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
      visible: true, locked: false
    });
  });

  // Sci-Fi Reticle / Crosshair Icon (Top Left Header)
  elements.push({
    id: 'cyber_reticle_ring', name: 'Reticle Targeting Ring', type: 'circle', layerId: 'etch',
    x: cx - 35, y: cy - 35, r: 4, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none', visible: true, locked: false
  });
  elements.push({
    id: 'cyber_reticle_cross_h', name: 'Reticle Horizontal Cross', type: 'line', layerId: 'etch',
    x: cx - 41, y: cy - 35, x2: 12, y2: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
  });
  elements.push({
    id: 'cyber_reticle_cross_v', name: 'Reticle Vertical Cross', type: 'line', layerId: 'etch',
    x: cx - 35, y: cy - 41, x2: 0, y2: 12, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.3, strokeColor: etchColor, visible: true, locked: false
  });

  // Hazard Warning Triangle Icon (Top Right Header)
  elements.push({
    id: 'cyber_hazard_triangle', name: 'Hazard Warning Icon', type: 'polygon', layerId: 'etch',
    x: cx + 35, y: cy - 35, r: 5, sides: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, fillColor: 'none', visible: true, locked: false
  });
  elements.push({
    id: 'cyber_hazard_exclamation', name: 'Hazard Exclamation Line', type: 'line', layerId: 'etch',
    x: cx + 35, y: cy - 36, x2: 0, y2: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    strokeWidth: 0.4, strokeColor: etchColor, visible: true, locked: false
  });

  // Sci-Fi Barcode / Data Stream (Bottom Left)
  for (let b = 0; b < 7; b++) {
    const bx = cx - 45 + b * 2;
    const bw = b % 2 === 0 ? 0.3 : 0.6;
    elements.push({
      id: `cyber_barcode_${b}`, name: `Data Barcode Strip ${b+1}`, type: 'line', layerId: 'etch',
      x: bx, y: cy + 18, x2: 0, y2: 10, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
      strokeWidth: bw, strokeColor: etchColor, visible: true, locked: false
    });
  }

  // Sci-Fi Typography Elements
  // Header Badge Title: "CYBER // ETCH 2026"
  elements.push({
    id: 'cyber_text_title', name: 'Badge Main Header Text', type: 'text', layerId: 'etch',
    x: cx - 22, y: cy - 54, text: 'CYBER // ETCH 2026', fontFamily: 'Orbitron', fontSize: 4.2, fontWeight: '800',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: etchColor,
    machining: 'filled', hatchOutline: false, visible: true, locked: false
  });

  // IC Label Text: "NEON-CORE"
  elements.push({
    id: 'cyber_text_ic', name: 'IC Core Title Text', type: 'text', layerId: 'etch',
    x: cx - 11, y: cy - 2, text: 'NEON-CORE', fontFamily: 'Fira Code', fontSize: 3.5, fontWeight: '700',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // Telemetry Specs Text 1: "SYS: ONLINE   PWR: 5.0V"
  elements.push({
    id: 'cyber_text_telem1', name: 'Telemetry Specs Text 1', type: 'text', layerId: 'etch',
    x: cx - 24, y: cy + 41, text: 'SYS: ONLINE   PWR: 5.0V', fontFamily: 'Fira Code', fontSize: 3.2, fontWeight: '600',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  // Telemetry Specs Text 2: "[SEC_CLR: OMNI-5]"
  elements.push({
    id: 'cyber_text_telem2', name: 'Telemetry Specs Text 2', type: 'text', layerId: 'etch',
    x: cx - 18, y: cy + 55, text: '[SEC_CLR: OMNI-5]', fontFamily: 'Press Start 2P', fontSize: 2.5, fontWeight: '400',
    rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: etchColor, fillColor: 'none',
    visible: true, locked: false
  });

  return elements;
}

function generateLivingHingeJournalElements(): EtchElement[] {
  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';
  const hingeColor = '#0ea5e9';

  const hingeSpec: LivingHingeSpec = {
    axis: 'y',
    slitLengthMm: 28,
    bridgeMm: 3,
    pitchMm: 3.5,
  };
  const spineW = 36;
  const spineH = 150;
  const { d: hingeD } = hingeField(spineW, spineH, hingeSpec);

  const elements: EtchElement[] = [
    // Wrap-around A6 cover outer perimeter (240x150mm)
    {
      id: 'journal_outer_cut',
      name: 'Wrap-Around Cover Perimeter',
      type: 'rect',
      layerId: 'cut',
      x: 30,
      y: 25,
      w: 240,
      h: 150,
      rx: 8,
      ry: 8,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Elastic closure strap slots on back cover (near spine-side of back flap)
    {
      id: 'journal_strap_top',
      name: 'Top Elastic Strap Slot',
      type: 'rect',
      layerId: 'cut',
      x: 116,
      y: 33,
      w: 3.5,
      h: 16,
      rx: 1.5,
      ry: 1.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_strap_bot',
      name: 'Bottom Elastic Strap Slot',
      type: 'rect',
      layerId: 'cut',
      x: 116,
      y: 151,
      w: 3.5,
      h: 16,
      rx: 1.5,
      ry: 1.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Parametric Living Hinge Spine (x: 132..168, y: 25..175)
    {
      id: 'journal_living_hinge',
      name: 'Living Hinge Spine',
      type: 'path',
      layerId: HINGE_LAYER_ID,
      d: hingeD,
      w: spineW,
      h: spineH,
      hinge: hingeSpec,
      x: 132,
      y: 25,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: hingeColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Front cover outer & inner framing borders (right side: x: 174..262, y: 31..169)
    {
      id: 'journal_front_frame',
      name: 'Front Cover Outer Frame',
      type: 'rect',
      layerId: 'etch',
      x: 174,
      y: 31,
      w: 88,
      h: 138,
      rx: 5,
      ry: 5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_front_inner_frame',
      name: 'Front Cover Chamfered Inner Frame',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 183 34 L 253 34 L 259 40 L 259 160 L 253 166 L 183 166 L 177 160 L 177 40 Z',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Header Banner Cartouche
    {
      id: 'journal_header_box',
      name: 'Header Banner Cartouche',
      type: 'rect',
      layerId: 'etch',
      x: 184,
      y: 39,
      w: 68,
      h: 13,
      rx: 2,
      ry: 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_title',
      name: 'Journal Cover Title',
      type: 'text',
      layerId: 'etch',
      x: 193.5,
      y: 42.5,
      text: 'FIELD NOTES',
      fontFamily: 'Orbitron',
      fontSize: 6.2,
      fontWeight: '800',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: etchColor,
      machining: 'filled',
      hatchOutline: false,
      visible: true,
      locked: false,
    },
    // Celestial Astrolabe & Organic Tree-of-Life Medallion (centered at x: 218, y: 96)
    {
      id: 'journal_compass_outer',
      name: 'Astrolabe Outer Ring',
      type: 'circle',
      layerId: 'etch',
      x: 218,
      y: 96,
      r: 32,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_compass_inner',
      name: 'Astrolabe Degree Ring',
      type: 'circle',
      layerId: 'etch',
      x: 218,
      y: 96,
      r: 28.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_tree_of_life',
      name: 'Botanical Tree of Life Medallion',
      type: 'path',
      layerId: 'fill',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.treeOfLife, 218, 96, 53, 53),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.32,
      strokeColor: fillColor,
      fillColor: fillColor,
      machining: 'filled',
      hatchAngle: 45,
      hatchSpacing: 0.55,
      hatchOutline: true,
      visible: true,
      locked: false,
    },
    {
      id: 'journal_front_flourish_top',
      name: 'Front Cover Upper Scroll Flourish',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.scrollFlourish, 218, 58, 38, 9, 0),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_front_flourish_bot',
      name: 'Front Cover Lower Scroll Flourish',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.scrollFlourish, 218, 133.5, 38, 8, 0, 1, -1),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Footer Cartouche & Expedition Coordinates
    {
      id: 'journal_footer_box',
      name: 'Footer Telemetry Cartouche',
      type: 'rect',
      layerId: 'etch',
      x: 184,
      y: 138,
      w: 68,
      h: 20,
      rx: 2,
      ry: 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_subtitle',
      name: 'Journal Cover Subtitle',
      type: 'text',
      layerId: 'etch',
      x: 190,
      y: 142,
      text: 'EXPEDITION LOG // NO. 04',
      fontFamily: 'Fira Code',
      fontSize: 3.5,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_coords',
      name: 'Journal Coordinates',
      type: 'text',
      layerId: 'etch',
      x: 192,
      y: 150,
      text: '46.8523° N // 121.7603° W',
      fontFamily: 'Fira Code',
      fontSize: 3.1,
      fontWeight: '600',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Back cover frame & emblem (left side: x: 46..110)
    {
      id: 'journal_back_frame',
      name: 'Back Cover Frame',
      type: 'rect',
      layerId: 'etch',
      x: 46,
      y: 33,
      w: 64,
      h: 134,
      rx: 4,
      ry: 4,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_medallion_outer',
      name: 'Back Cover Emblem Outer Ring',
      type: 'circle',
      layerId: 'etch',
      x: 78,
      y: 92,
      r: 17,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.32,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_medallion_ring',
      name: 'Back Cover Emblem Ring',
      type: 'circle',
      layerId: 'etch',
      x: 78,
      y: 92,
      r: 14.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_compass_rose',
      name: 'Back Cover Faceted Compass Rose',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.compassRose, 78, 92, 26, 26),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_lotus_top',
      name: 'Back Cover Upper Lotus Flourish',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.lotusBloom, 78, 58, 22, 18),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_scroll_bot',
      name: 'Back Cover Lower Scroll Flourish',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.scrollFlourish, 78, 124, 32, 14, 0, 1, -1),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'journal_back_badge',
      name: 'Back Cover Maker Stamp',
      type: 'text',
      layerId: 'etch',
      x: 59,
      y: 150,
      text: 'PHYSBOX ATELIER',
      fontFamily: 'Outfit',
      fontSize: 4.4,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
  ];

  // Add 24 astrolabe degree ticks around the front cover medallion (cx=218, cy=96)
  for (let i = 0; i < 24; i++) {
    const angle = (i * 15 * Math.PI) / 180;
    const rIn = i % 2 === 0 ? 25.5 : 27;
    const rOut = 31.8;
    const x1 = +(218 + rIn * Math.cos(angle)).toFixed(2);
    const y1 = +(96 + rIn * Math.sin(angle)).toFixed(2);
    const dx = +((rOut - rIn) * Math.cos(angle)).toFixed(2);
    const dy = +((rOut - rIn) * Math.sin(angle)).toFixed(2);
    elements.push({
      id: `journal_astrolabe_tick_${i}`,
      name: `Astrolabe Tick ${i * 15}°`,
      type: 'line',
      layerId: 'etch',
      x: x1,
      y: y1,
      x2: dx,
      y2: dy,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: i % 6 === 0 ? 0.4 : 0.25,
      strokeColor: etchColor,
      visible: true,
      locked: false,
    });
  }

  // Add 12cm metric field ruler along the OUTER LEFT edge of the back cover (x = 30.5, y = 36..156)
  for (let mm = 0; mm <= 120; mm += 2) {
    const y = 36 + mm;
    const isCm = mm % 10 === 0;
    const isHalfCm = mm % 5 === 0;
    const tickLen = isCm ? 6.5 : isHalfCm ? 4.5 : 2.5;
    elements.push({
      id: `journal_ruler_tick_${mm}`,
      name: `Ruler Tick ${mm}mm`,
      type: 'line',
      layerId: 'etch',
      x: 30.8,
      y,
      x2: tickLen,
      y2: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: isCm ? 0.35 : 0.22,
      strokeColor: etchColor,
      visible: true,
      locked: false,
    });
    if (isCm && mm % 20 === 0) {
      elements.push({
        id: `journal_ruler_lbl_${mm}`,
        name: `Ruler Label ${mm / 10}cm`,
        type: 'text',
        layerId: 'etch',
        x: 38.2,
        y: y - 1.5,
        text: `${mm / 10}`,
        fontFamily: 'Fira Code',
        fontSize: 2.8,
        fontWeight: '600',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      });
    }
  }

  return elements;
}

function generateSynthGrilleElements(): EtchElement[] {
  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';
  const perfColor = '#14b8a6';

  const perfSpec: PerforationSpec = {
    lattice: 'hex',
    shape: 'round',
    sizeMm: 5.2,
    slotLengthMm: 5.2,
    pitchMm: 7.8,
    ramp: 'radial',
  };
  const grilleW = 100;
  const grilleH = 100;
  const { d: perfD } = perforationField(grilleW, grilleH, perfSpec);

  const elements: EtchElement[] = [
    // Faceplate outer contour (260x140mm)
    {
      id: 'synth_panel_cut',
      name: 'Faceplate Outer Boundary',
      type: 'rect',
      layerId: 'cut',
      x: 20,
      y: 30,
      w: 260,
      h: 140,
      rx: 4,
      ry: 4,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Outer panel hairline border
    {
      id: 'synth_panel_inner_border',
      name: 'Faceplate Margin Trim Line',
      type: 'rect',
      layerId: 'etch',
      x: 23,
      y: 33,
      w: 254,
      h: 134,
      rx: 3,
      ry: 3,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // 4x Eurorack / Chassis Oblong Mounting Slots
    ...[
      { id: 'synth_slot_tl', name: 'Top-Left Rack Slot', x: 27, y: 36 },
      { id: 'synth_slot_tr', name: 'Top-Right Rack Slot', x: 265.5, y: 36 },
      { id: 'synth_slot_bl', name: 'Bottom-Left Rack Slot', x: 27, y: 160.8 },
      { id: 'synth_slot_br', name: 'Bottom-Right Rack Slot', x: 265.5, y: 160.8 },
    ].map((s) => ({
      id: s.id,
      name: s.name,
      type: 'rect' as const,
      layerId: 'cut',
      x: s.x,
      y: s.y,
      w: 7.5,
      h: 3.2,
      rx: 1.6,
      ry: 1.6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    })),
    // Radially ramped hexagonal speaker grille perforation (100x100mm centered at 92, 100)
    {
      id: 'synth_speaker_perforation',
      name: 'Acoustic Hex Speaker Grille',
      type: 'path',
      layerId: PERFORATION_LAYER_ID,
      d: perfD,
      w: grilleW,
      h: grilleH,
      perforation: perfSpec,
      x: 42,
      y: 50,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: perfColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Rounded-square transducer baffle frame enclosing the entire hex grille + circular cone ring
    {
      id: 'synth_grille_baffle_box',
      name: 'Transducer Baffle Frame',
      type: 'rect',
      layerId: 'etch',
      x: 34,
      y: 42,
      w: 116,
      h: 116,
      rx: 12,
      ry: 12,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'synth_grille_bezel',
      name: 'Acoustic Transducer Cone Ring',
      type: 'circle',
      layerId: 'etch',
      x: 92,
      y: 100,
      r: 49,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // 4x M3 Speaker Driver Corner Mounting Holes + Washer Rings (sit cleanly in the unperforated corners of the radial ramp)
    ...[
      { id: 'tl', x: 43, y: 51 },
      { id: 'tr', x: 141, y: 51 },
      { id: 'bl', x: 43, y: 149 },
      { id: 'br', x: 141, y: 149 },
    ].flatMap((m) => [
      {
        id: `synth_driver_mount_${m.id}`,
        name: `Driver Mount Hole (${m.id.toUpperCase()})`,
        type: 'circle' as const,
        layerId: 'cut',
        x: m.x,
        y: m.y,
        r: 1.6,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: cutColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: `synth_driver_washer_${m.id}`,
        name: `Driver Washer Ring (${m.id.toUpperCase()})`,
        type: 'circle' as const,
        layerId: 'etch',
        x: m.x,
        y: m.y,
        r: 3.2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
    ]),
    // Control section divider frame
    {
      id: 'synth_control_frame',
      name: 'Control Bay Frame',
      type: 'rect',
      layerId: 'etch',
      x: 158,
      y: 42,
      w: 112,
      h: 116,
      rx: 4,
      ry: 4,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Header accent bar
    {
      id: 'synth_header_pocket',
      name: 'Header Accent Bar',
      type: 'rect',
      layerId: 'fill',
      x: 164,
      y: 47,
      w: 100,
      h: 3.5,
      rx: 1,
      ry: 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: fillColor,
      fillColor: fillColor,
      machining: 'filled',
      hatchAngle: 45,
      hatchSpacing: 0.6,
      hatchOutline: true,
      visible: true,
      locked: false,
    },
    {
      id: 'synth_title_text',
      name: 'Module Title Label',
      type: 'text',
      layerId: 'etch',
      x: 164,
      y: 54,
      text: 'PHYSBOX // MONO-01',
      fontFamily: 'Orbitron',
      fontSize: 5.2,
      fontWeight: '800',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'synth_section_rule_1',
      name: 'VCA / VCF Section Divider',
      type: 'line',
      layerId: 'etch',
      x: 164,
      y: 63,
      x2: 100,
      y2: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeColor: etchColor,
      visible: true,
      locked: false,
    },
    {
      id: 'synth_section_rule_2',
      name: 'I/O Patch Bay Divider',
      type: 'line',
      layerId: 'etch',
      x: 164,
      y: 116,
      x2: 100,
      y2: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeColor: etchColor,
      visible: true,
      locked: false,
    },
  ];

  // 3 Potentiometer cutouts + dial collars + 11 radial calibration tick marks each
  const pots = [
    { id: 'gain', label: 'DRIVE', x: 180, y: 84, labelX: 173 },
    { id: 'cutoff', label: 'CUTOFF', x: 214, y: 84, labelX: 205 },
    { id: 'reso', label: 'RESO', x: 248, y: 84, labelX: 241 },
  ];
  for (const pot of pots) {
    elements.push({
      id: `pot_hole_${pot.id}`,
      name: `${pot.label} Potentiometer Shaft Hole`,
      type: 'circle',
      layerId: 'cut',
      x: pot.x,
      y: pot.y,
      r: 3.6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    elements.push({
      id: `pot_collar_${pot.id}`,
      name: `${pot.label} Dial Inner Collar`,
      type: 'circle',
      layerId: 'etch',
      x: pot.x,
      y: pot.y,
      r: 6.8,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    for (let t = 0; t <= 10; t++) {
      const deg = -225 + t * 27; // -225° (7:30) to +45° (4:30)
      const rad = (deg * Math.PI) / 180;
      const rIn = 7.6;
      const rOut = t % 5 === 0 ? 11.2 : 9.8;
      elements.push({
        id: `pot_tick_${pot.id}_${t}`,
        name: `${pot.label} Scale Tick ${t}`,
        type: 'line',
        layerId: 'etch',
        x: +(pot.x + rIn * Math.cos(rad)).toFixed(2),
        y: +(pot.y + rIn * Math.sin(rad)).toFixed(2),
        x2: +((rOut - rIn) * Math.cos(rad)).toFixed(2),
        y2: +((rOut - rIn) * Math.sin(rad)).toFixed(2),
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: t % 5 === 0 ? 0.35 : 0.22,
        strokeColor: etchColor,
        visible: true,
        locked: false,
      });
    }
    elements.push({
      id: `pot_label_${pot.id}`,
      name: `${pot.label} Label`,
      type: 'text',
      layerId: 'etch',
      x: pot.labelX,
      y: pot.y + 13.5,
      text: pot.label,
      fontFamily: 'Fira Code',
      fontSize: 3.1,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
  }

  // 3x 6.35mm (1/4") Patch / Audio Jack Holes with Hex Bushing & Washer Rings
  const jacks = [
    { id: 'voct', label: 'V/OCT', x: 180, y: 134, labelX: 173 },
    { id: 'in', label: 'LINE IN', x: 214, y: 134, labelX: 204.5 },
    { id: 'out', label: 'MON OUT', x: 248, y: 134, labelX: 238.5 },
  ];
  for (const jack of jacks) {
    elements.push({
      id: `jack_hole_${jack.id}`,
      name: `${jack.label} Jack Cutout`,
      type: 'circle',
      layerId: 'cut',
      x: jack.x,
      y: jack.y,
      r: 4.6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    elements.push({
      id: `jack_washer_${jack.id}`,
      name: `${jack.label} Washer Ring`,
      type: 'circle',
      layerId: 'etch',
      x: jack.x,
      y: jack.y,
      r: 6.0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.22,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    elements.push({
      id: `jack_bushing_${jack.id}`,
      name: `${jack.label} Hex Bushing Outline`,
      type: 'polygon',
      layerId: 'etch',
      x: jack.x,
      y: jack.y,
      r: 8.2,
      sides: 6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
    elements.push({
      id: `jack_label_${jack.id}`,
      name: `${jack.label} Label`,
      type: 'text',
      layerId: 'etch',
      x: jack.labelX,
      y: jack.y + 11,
      text: jack.label,
      fontFamily: 'Fira Code',
      fontSize: 3.0,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    });
  }

  return elements;
}

function buildRegistrationPinElements(prefix: string): EtchElement[] {
  const regColor = '#f59e0b';
  return [
    {
      id: `${prefix}_reg_tl`,
      name: 'Registration Hole 1 (Top-Left)',
      type: 'circle',
      layerId: REGISTRATION_LAYER_ID,
      x: 18,
      y: 18,
      r: 1.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: regColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: `${prefix}_reg_tr`,
      name: 'Registration Hole 2 (Top-Right)',
      type: 'circle',
      layerId: REGISTRATION_LAYER_ID,
      x: 162,
      y: 18,
      r: 1.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: regColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: `${prefix}_reg_bl`,
      name: 'Registration Hole 3 (Bottom-Left)',
      type: 'circle',
      layerId: REGISTRATION_LAYER_ID,
      x: 18,
      y: 162,
      r: 1.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: regColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
  ];
}

function generateMountainDioramaPreset(): EtchDocument {
  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';

  const sharedLayers = [
    { id: 'cut', name: 'Vector Cut', color: cutColor, operation: 'cut' as const, visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
    { id: 'etch', name: 'Vector Etch', color: etchColor, operation: 'etch' as const, visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
    { id: 'fill', name: 'Raster Pocket Fill', color: fillColor, operation: 'fill' as const, visible: true, locked: false, speed: 2400, power: 45, passes: 1, zDepth: 0.8 },
    { id: REGISTRATION_LAYER_ID, name: 'Registration', color: '#f59e0b', operation: 'cut' as const, visible: true, locked: false, speed: 400, power: 95, passes: 1, zDepth: 3.3, cutSide: 'inside' as const, tabs: false },
  ];

  // Organic multi-bough conifer silhouette with sweeping curved branches (traversed right-to-left along the bottom of the window)
  const buildOrganicConifer = (cx: number, baseRightY: number, baseLeftY: number, topY: number, halfW: number, lean = 0): string => {
    const h = Math.min(baseRightY, baseLeftY) - topY;
    const tiers = [0.22, 0.42, 0.62, 0.82, 0.96];
    const widths = [0.34, 0.56, 0.76, 0.92, 1.0];
    const f = (n: number) => +n.toFixed(1);
    const pts: string[] = [`L ${f(cx + halfW * 0.22)} ${f(baseRightY)}`];
    // Ascend right side from bottom tier to crown
    for (let i = tiers.length - 1; i >= 0; i--) {
      const ty = topY + h * tiers[i];
      const w = halfW * widths[i];
      const tipX = cx + lean * (1 - tiers[i]) + w;
      const tipY = ty + 1.8;
      const notchX = cx + lean * (1 - tiers[i]) + w * 0.36;
      const notchY = ty - h * 0.08;
      pts.push(`Q ${f(cx + w * 0.65)} ${f(tipY + 0.6)} ${f(tipX)} ${f(tipY)}`);
      pts.push(`Q ${f(cx + w * 0.6)} ${f(ty - 0.4)} ${f(notchX)} ${f(notchY)}`);
    }
    // Crown spire
    pts.push(`L ${f(cx + lean)} ${f(topY)}`);
    // Descend left side from crown to bottom tier
    for (let i = 0; i < tiers.length; i++) {
      const ty = topY + h * tiers[i];
      const w = halfW * widths[i];
      const notchX = cx + lean * (1 - tiers[i]) - w * 0.36;
      const notchY = ty - h * 0.08;
      const tipX = cx + lean * (1 - tiers[i]) - w;
      const tipY = ty + 1.8;
      pts.push(`L ${f(notchX)} ${f(notchY)}`);
      pts.push(`Q ${f(cx - w * 0.6)} ${f(ty - 0.4)} ${f(tipX)} ${f(tipY)}`);
    }
    pts.push(`L ${f(cx - halfW * 0.22)} ${f(baseLeftY)}`);
    return pts.join(' ');
  };

  // Tall conifers frame the left and right edges while dipping toward a central alpine valley vista
  const pineWindowD = [
    'M 32 88',
    'A 58 58 0 0 1 148 88',
    'L 148 118',
    buildOrganicConifer(139, 118, 121, 74, 8.5, -0.8),
    buildOrganicConifer(125, 121, 125, 84, 7.5, -0.5),
    buildOrganicConifer(112, 125, 128, 95, 6.2, -0.3),
    // Central valley vista saddle with low timberline scrub
    'Q 101 131 95 129',
    buildOrganicConifer(89, 129, 129, 104, 5.0, 0),
    'Q 81 131 74 128',
    buildOrganicConifer(67, 128, 125, 93, 6.5, 0.4),
    buildOrganicConifer(54, 125, 121, 81, 7.8, 0.6),
    buildOrganicConifer(40, 121, 118, 72, 8.8, 0.9),
    'L 32 118 Z',
  ].join(' ');

  const spandrelLeftD = placeArt(ORGANIC_MOTIFS.scrollFlourish, 37, 37, 22, 16, -45, 1, 1);
  const spandrelRightD = placeArt(ORGANIC_MOTIFS.scrollFlourish, 143, 37, 22, 16, 45, -1, 1);

  // Sheet 1 (Front): Window Frame & Tiered Conifer Forest Silhouette
  const sheet1Elements: EtchElement[] = [
    {
      id: 'diorama_s1_outer',
      name: 'Outer Shadow-Box Frame',
      type: 'rect',
      layerId: 'cut',
      x: 10,
      y: 10,
      w: 160,
      h: 160,
      rx: 8,
      ry: 8,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Foreground window aperture with organic conifer forest rising along the bottom edge
    {
      id: 'diorama_s1_aperture',
      name: 'Foreground Pine Forest Window Cutout',
      type: 'path',
      layerId: 'cut',
      x: 0,
      y: 0,
      d: pineWindowD,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'diorama_s1_bezel',
      name: 'Outer Compass Bezel Frame',
      type: 'rect',
      layerId: 'etch',
      x: 22,
      y: 22,
      w: 136,
      h: 136,
      rx: 4,
      ry: 4,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'diorama_s1_inner_bezel',
      name: 'Inner Dashed Map Border',
      type: 'rect',
      layerId: 'etch',
      x: 25,
      y: 25,
      w: 130,
      h: 130,
      rx: 3,
      ry: 3,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    ...(spandrelLeftD
      ? [
          {
            id: 'diorama_s1_spandrel_left',
            name: 'Upper Left Arch Botanical Spandrel',
            type: 'path' as const,
            layerId: 'etch',
            x: 0,
            y: 0,
            d: spandrelLeftD,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.26,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    ...(spandrelRightD
      ? [
          {
            id: 'diorama_s1_spandrel_right',
            name: 'Upper Right Arch Botanical Spandrel',
            type: 'path' as const,
            layerId: 'etch',
            x: 0,
            y: 0,
            d: spandrelRightD,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.26,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    // Engraved tree trunks, bough ribs & foreground foothill contour lines
    {
      id: 'diorama_s1_foothill_1',
      name: 'Foreground Timberline & Foothill Contours',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 40 76 L 40 124 M 54 85 L 54 127 M 67 96 L 67 130 M 89 106 L 89 131 M 112 98 L 112 130 M 125 87 L 125 127 M 139 78 L 139 124 M 30 126 Q 58 134 90 132 T 150 125 M 30 133 Q 65 139 95 136 T 150 132',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'diorama_s1_plaque_box',
      name: 'Elevation Title Plaque Frame',
      type: 'rect',
      layerId: 'etch',
      x: 42,
      y: 140,
      w: 96,
      h: 11,
      rx: 2,
      ry: 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'diorama_s1_label',
      name: 'Elevation Title Plaque',
      type: 'text',
      layerId: 'etch',
      x: 49,
      y: 143,
      text: 'CASCADE ALPINE // 4,392M',
      fontFamily: 'Orbitron',
      fontSize: 4.5,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    ...buildRegistrationPinElements('s1'),
  ];

  // Sheet 2 (Middle): Craggy Alpine Massif, Woodcut Glaciers & Sub-Alpine Timberline
  const alpineSubTreesD = [
    placeArt(ORGANIC_MOTIFS.pineTree, 46, 108, 9, 12.5),
    placeArt(ORGANIC_MOTIFS.pineTree, 55, 111, 7.5, 10.5),
    placeArt(ORGANIC_MOTIFS.pineTree, 76, 107, 8.5, 12),
    placeArt(ORGANIC_MOTIFS.pineTree, 84, 110, 7.5, 10),
    placeArt(ORGANIC_MOTIFS.pineTree, 105, 108, 8.5, 12),
    placeArt(ORGANIC_MOTIFS.pineTree, 114, 111, 7.5, 10),
    placeArt(ORGANIC_MOTIFS.pineTree, 136, 109, 9, 12.5),
  ].join(' ');

  const sheet2: EtchDocument = {
    id: 'doc_diorama_sheet2',
    name: 'Sheet 2 — Alpine Peaks',
    width: 180,
    height: 180,
    gridSize: 10,
    snapToGrid: true,
    units: 'mm',
    origin: 'top-left',
    material: 'plywood',
    stockThickness: 3,
    notecard: `### Sheet 2 — Midground Alpine Peaks
- Stacks directly behind Sheet 1 on 3mm alignment dowels.
- Cuts a craggy alpine massif across the middle of the window with woodcut glacier snow-cap pockets, winding arête ridges, and sub-alpine conifers.`,
    layers: sharedLayers.map((l) => ({ ...l })),
    selectedIds: [],
    elements: [
      {
        id: 'diorama_s2_outer',
        name: 'Sheet 2 Outer Frame',
        type: 'rect',
        layerId: 'cut',
        x: 10,
        y: 10,
        w: 160,
        h: 160,
        rx: 8,
        ry: 8,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: cutColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Sky cutout with craggy, multi-stepped alpine massif silhouette
      {
        id: 'diorama_s2_sky_cutout',
        name: 'Alpine Range Sky Cutout',
        type: 'path',
        layerId: 'cut',
        x: 0,
        y: 0,
        d: 'M 28 28 L 152 28 L 152 104 L 146 96 L 142 98 L 137 86 L 133 78 L 129 66 L 124 54 L 119 63 L 116 61 L 111 74 L 106 85 L 101 79 L 96 69 L 91 62 L 87 70 L 84 76 L 79 84 L 74 75 L 70 64 L 66 56 L 60 46 L 55 55 L 52 53 L 47 66 L 43 76 L 38 71 L 33 82 L 28 94 Z',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: cutColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // West Peak Shadowed Glacier Facet (woodcut curved couloirs & seracs on east-facing slope of peak 60,46)
      {
        id: 'diorama_s2_snow_left',
        name: 'West Peak Shaded Glacier Facet',
        type: 'path',
        layerId: 'fill',
        x: 0,
        y: 0,
        d: 'M 60 48 L 66 57 L 70 65 L 74 76 L 78 84 C 73 88 70 92 67 95 C 65 89 63 85 61 82 C 59 87 57 91 55 94 C 55 83 57 72 61 62 C 59 57 59 52 60 48 Z',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: fillColor,
        fillColor: fillColor,
        machining: 'filled',
        hatchAngle: 45,
        hatchSpacing: 0.55,
        hatchOutline: true,
        visible: true,
        locked: false,
      },
      // Central Needle Shadowed Glacier Facet (east face of peak 91,62)
      {
        id: 'diorama_s2_snow_mid',
        name: 'Central Spire Shaded Glacier Facet',
        type: 'path',
        layerId: 'fill',
        x: 0,
        y: 0,
        d: 'M 91 64 L 96 70 L 101 80 L 105 86 C 101 90 98 94 95 96 C 93 90 91 86 89 83 C 90 76 92 70 91 64 Z',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: fillColor,
        fillColor: fillColor,
        machining: 'filled',
        hatchAngle: 45,
        hatchSpacing: 0.55,
        hatchOutline: true,
        visible: true,
        locked: false,
      },
      // East Massif Shadowed Glacier Facet (east face of peak 124,54)
      {
        id: 'diorama_s2_snow_right',
        name: 'East Peak Shaded Glacier Facet',
        type: 'path',
        layerId: 'fill',
        x: 0,
        y: 0,
        d: 'M 124 56 L 129 67 L 133 79 L 137 87 L 141 97 C 136 99 133 95 130 91 C 128 95 125 98 122 96 C 121 86 123 76 126 67 C 124 62 123 59 124 56 Z',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: fillColor,
        fillColor: fillColor,
        machining: 'filled',
        hatchAngle: 45,
        hatchSpacing: 0.55,
        hatchOutline: true,
        visible: true,
        locked: false,
      },
      // Sunlit west-facing rock strata, couloirs & winding ridge lines
      {
        id: 'diorama_s2_arete_lines',
        name: 'Sunlit Slope Strata & Arête Lines',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: 'M 60 48 C 58 60 54 74 50 88 M 52 55 C 49 65 45 75 41 86 M 38 72 C 41 80 43 88 40 95 M 91 64 C 88 74 85 83 82 92 M 124 56 C 120 68 117 80 113 92 M 116 62 C 112 72 109 81 106 90 M 56 62 L 48 74 M 58 70 L 50 82 M 88 72 L 81 82 M 120 66 L 112 78 M 121 75 L 114 86',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Sub-alpine timberline conifers nestled along the valley floor
      {
        id: 'diorama_s2_timberline',
        name: 'Sub-Alpine Valley Timberline Trees',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: alpineSubTreesD,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.26,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: 'diorama_s2_ridge_1',
        name: 'Topographic Ridge Contour 1',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: 'M 32 117 C 54 109 74 120 96 113 C 118 106 132 117 148 114',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.35,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: 'diorama_s2_ridge_2',
        name: 'Topographic Ridge Contour 2',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: 'M 32 123 C 56 115 76 125 98 119 C 120 113 134 122 148 120',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.32,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: 'diorama_s2_ridge_3',
        name: 'Topographic Ridge Contour 3',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: 'M 32 129 C 58 121 78 130 100 125 C 122 120 136 128 148 126',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.28,
        strokeDash: 'dashed',
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      ...buildRegistrationPinElements('s2'),
    ],
  };

  // Sheet 3 (Back): Horizon Sunburst, Guilloche Spirograph Corona, Soaring Birds & Starfield Backing Plate
  const guillocheSpec = ornamentById('guilloche');
  const sunCoronaGuillocheD = guillocheSpec
    ? guillocheSpec.build(
        { x: 0, y: 0, width: 68, height: 68 },
        { figure: 'spirograph', rings: 1, lobes: 24, turns: 5, depth: 0.18, ripple: 0.04, spacing: 3 }
      )
    : '';
  const skyBirdsD = [
    placeArt(ORGANIC_MOTIFS.gullBirds, 46, 56, 15, 10, -8),
    placeArt(ORGANIC_MOTIFS.gullBirds, 138, 48, 15, 10, 10),
    placeArt(ORGANIC_MOTIFS.gullBirds, 68, 30, 12, 8, -4),
  ].join(' ');

  const sheet3: EtchDocument = {
    id: 'doc_diorama_sheet3',
    name: 'Sheet 3 — Horizon Sun Backing',
    width: 180,
    height: 180,
    gridSize: 10,
    snapToGrid: true,
    units: 'mm',
    origin: 'top-left',
    material: 'plywood',
    stockThickness: 3,
    notecard: `### Sheet 3 — Horizon Sun & Starfield Backing
- Solid rear backing plate aligned via the same 3mm L-pattern registration holes.
- Features an engraved rose-engine spirograph solar corona, 24-ray horizon sunburst, soaring alpine birds, crescent moon, and starfield visible behind the mountain peaks.`,
    layers: sharedLayers.map((l) => ({ ...l })),
    selectedIds: [],
    elements: [
      {
        id: 'diorama_s3_outer',
        name: 'Sheet 3 Solid Backing Cutout',
        type: 'rect',
        layerId: 'cut',
        x: 10,
        y: 10,
        w: 160,
        h: 160,
        rx: 8,
        ry: 8,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: cutColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Wall Hanger Keyhole Cutout
      {
        id: 'diorama_s3_hanger',
        name: 'Rear Wall Mount Hole',
        type: 'circle',
        layerId: 'cut',
        x: 90,
        y: 20,
        r: 2.5,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.2,
        strokeColor: cutColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Concentric Solar Halo Ring (centered at 94, 70 with r=38 so top is at y=32, well clear of y=20 hanger hole)
      {
        id: 'diorama_s3_halo_outer',
        name: 'Outer Solar Corona Ring',
        type: 'circle',
        layerId: 'etch',
        x: 94,
        y: 70,
        r: 38,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeDash: 'dashed',
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      ...(sunCoronaGuillocheD
        ? [
            {
              id: 'diorama_s3_corona_guilloche',
              name: 'Rose-Engine Spirograph Solar Corona',
              type: 'path' as const,
              layerId: 'etch',
              x: 60,
              y: 36,
              d: sunCoronaGuillocheD,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              strokeWidth: 0.22,
              strokeColor: etchColor,
              fillColor: 'none',
              visible: true,
              locked: false,
            },
          ]
        : []),
      // Horizon Sunburst Rays
      {
        id: 'diorama_s3_sunburst',
        name: 'Horizon Sunburst Rays',
        type: 'star',
        shape: 'star',
        layerId: 'etch',
        x: 94,
        y: 70,
        pointsCount: 24,
        innerRadius: 13.5,
        outerRadius: 25,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.28,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: 'diorama_s3_sun_core',
        name: 'Solar Disc Fill',
        type: 'circle',
        layerId: 'fill',
        x: 94,
        y: 70,
        r: 11.5,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: fillColor,
        fillColor: fillColor,
        machining: 'filled',
        hatchAngle: 0,
        hatchSpacing: 0.6,
        hatchOutline: true,
        visible: true,
        locked: false,
      },
      // Soaring Alpine Birds & Horizon Cloud Banks
      {
        id: 'diorama_s3_birds',
        name: 'Soaring Alpine Bird Flocks',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: skyBirdsD,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.32,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: 'diorama_s3_clouds',
        name: 'Billowing Horizon Cloud Contours',
        type: 'path',
        layerId: 'etch',
        x: 0,
        y: 0,
        d: 'M 28 65 Q 33 60 39 63 Q 45 58 51 63 Q 54 61 56 65 Z M 132 61 Q 137 56 142 59 Q 147 54 152 59 Q 155 57 157 61 Z',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.26,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Crescent Moon in Upper Left Sky (outside the r=38 corona ring)
      {
        id: 'diorama_s3_moon',
        name: 'Crescent Moon',
        type: 'star',
        shape: 'moon',
        layerId: 'etch',
        x: 42,
        y: 44,
        innerRadius: 4.5,
        outerRadius: 9,
        rotation: -20,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.35,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      // Celestial Starfield (4-Point Stars placed cleanly outside the r=38 corona ring)
      ...[
        { id: 'st1', x: 60, y: 30, r: 4.2 },
        { id: 'st2', x: 134, y: 34, r: 4.8 },
        { id: 'st3', x: 144, y: 72, r: 3.8 },
        { id: 'st4', x: 38, y: 72, r: 3.8 },
      ].map((st) => ({
        id: `diorama_s3_${st.id}`,
        name: `Celestial Star (${st.id.toUpperCase()})`,
        type: 'star' as const,
        shape: 'star' as const,
        layerId: 'etch',
        x: st.x,
        y: st.y,
        pointsCount: 4,
        innerRadius: +(st.r * 0.28).toFixed(2),
        outerRadius: st.r,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.28,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      })),
      ...buildRegistrationPinElements('s3'),
    ],
  };

  return {
    id: 'doc_diorama_sheet1',
    name: 'Sheet 1 — Pine Frame',
    width: 180,
    height: 180,
    gridSize: 10,
    snapToGrid: true,
    units: 'mm',
    origin: 'top-left',
    material: 'plywood',
    stockThickness: 3,
    notecard: `### 3-Sheet Topographic Alpine Shadow Box
- **Multi-Sheet Job**: Uses the bottom sheet tab strip (**Sheet 1 — Pine Frame**, **Sheet 2 — Alpine Peaks**, **Sheet 3 — Horizon Sun Backing**).
- **Registration Layer (Amber)**: 3x 3mm dowel holes in an L-pattern at (18,18), (162,18), and (18,162) so the 3 sheets can only be stacked and glued in the right orientation.`,
    layers: sharedLayers,
    selectedIds: [],
    elements: sheet1Elements,
    sheets: [sheet2, sheet3],
    sheetIndex: 0,
  };
}

function generateVCarveGuildSignElements(): EtchElement[] {
  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';
  const ghostColor = '#94a3b8';

  const guillocheSpec = ornamentById('guilloche');
  // Multi-turn rose-engine guilloche with 5 interleaved laps inside the chapter ring
  const rosetteD = guillocheSpec
    ? guillocheSpec.build(
        { x: 0, y: 0, width: 48, height: 48 },
        { figure: 'rosette', rings: 1, lobes: 16, depth: 0.25, turns: 5, ripple: 0.06, spacing: 3.5 }
      )
    : '';

  const foliageSpec = ornamentById('foliage');
  const leftLaurelD = foliageSpec
    ? foliageSpec.build(
        { x: 0, y: 0, width: 48, height: 18 },
        { scrolls: 3, leafEvery: 3, leafSizeMm: 8, tendrils: 1, stemWidthMm: 0.45, spread: 0.22, midrib: 'on', symmetry: 'none', seed: 7 }
      )
    : '';
  const rightLaurelD = leftLaurelD ? transformPathD(leftLaurelD, [-1, 0, 0, 1, 48, 0], 2) : '';

  const elements: EtchElement[] = [
    // Scalloped heritage plaque outer contour (240x150mm centered at 150, 100)
    {
      id: 'guild_outer_cut',
      name: 'Heritage Plaque Outer Cutout',
      type: 'path',
      layerId: 'cut',
      x: 0,
      y: 0,
      d: 'M 50 25 L 250 25 A 20 20 0 0 0 270 45 L 270 155 A 20 20 0 0 0 250 175 L 50 175 A 20 20 0 0 0 30 155 L 30 45 A 20 20 0 0 0 50 25 Z',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Chamfered outer & inner V-carve borders
    {
      id: 'guild_inner_vborder',
      name: 'V-Carved Outer Chamfer Border',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 54 31 L 246 31 A 18 18 0 0 0 264 49 L 264 151 A 18 18 0 0 0 246 169 L 54 169 A 18 18 0 0 0 36 151 L 36 49 A 18 18 0 0 0 54 31 Z',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.45,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'guild_inner_vborder_2',
      name: 'V-Carved Inner Fine Border',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 57 35 L 243 35 A 16 16 0 0 0 259 51 L 259 149 A 16 16 0 0 0 243 165 L 57 165 A 16 16 0 0 0 41 149 L 41 51 A 16 16 0 0 0 57 35 Z',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // 4 Corner Scrollwork Spandrels inside the chamfered plaque frame
    ...[
      { id: 'tl', x: 64, y: 50, rot: -45, fx: 1 as const, fy: 1 as const },
      { id: 'tr', x: 236, y: 50, rot: 45, fx: -1 as const, fy: 1 as const },
      { id: 'bl', x: 64, y: 150, rot: 45, fx: 1 as const, fy: -1 as const },
      { id: 'br', x: 236, y: 150, rot: -45, fx: -1 as const, fy: -1 as const },
    ].map((sp) => ({
      id: `guild_corner_scroll_${sp.id}`,
      name: `Corner Scroll Spandrel (${sp.id.toUpperCase()})`,
      type: 'path' as const,
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.scrollFlourish, sp.x, sp.y, 16, 12, sp.rot, sp.fx, sp.fy),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.26,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    })),
    // Ghost construction arc for curved header typography
    {
      id: 'guild_arch_guide',
      name: 'Upper Arch Text Guide Path',
      type: 'path',
      layerId: 'ghost',
      ghostFromLayerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 56 78 Q 150 32 244 78',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeDash: 'dashed',
      strokeColor: ghostColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Arched text riding the ghost guide path
    {
      id: 'guild_arched_title',
      name: 'Arched Guild Title (Text on Path)',
      type: 'text',
      layerId: 'etch',
      x: 75,
      y: 53,
      text: 'CHRONOGRAPH & HOROLOGY',
      fontFamily: 'Orbitron',
      fontSize: 6.8,
      fontWeight: '800',
      textPathId: 'guild_arch_guide',
      textPathAlign: 'center',
      textPathSide: 'above',
      textPathOffset: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: etchColor,
      machining: 'filled',
      hatchOutline: true,
      visible: true,
      locked: false,
    },
    // Strictly concentric Horology Escapement Wheel, Dial Ring, & Guilloche Rosette at (150, 99)
    {
      id: 'guild_escapement_gear',
      name: 'Central Escapement Wheel',
      type: 'star',
      shape: 'gear',
      layerId: 'etch',
      x: 150,
      y: 99,
      pointsCount: 24,
      innerRadius: 33,
      outerRadius: 38,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'guild_dial_outer_ring',
      name: 'Chapter Ring Outer Bezel',
      type: 'circle',
      layerId: 'etch',
      x: 150,
      y: 99,
      r: 30.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'guild_dial_inner_ring',
      name: 'Chapter Ring Inner Bezel',
      type: 'circle',
      layerId: 'etch',
      x: 150,
      y: 99,
      r: 25.5,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    ...(rosetteD
      ? [
          {
            id: 'guild_guilloche_rosette',
            name: 'Engine-Turned Dial Rosette',
            type: 'path' as const,
            layerId: 'etch',
            d: rosetteD,
            x: 126,
            y: 75,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.24,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    {
      id: 'guild_center_compass_rose',
      name: 'Tourbillon Faceted Compass Rose',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.compassRose, 150, 99, 18, 18),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Left & Right Flanking Sub-Dial Medallions with Heraldic Fleur-de-Lis Emblems
    ...[
      { id: 'west', x: 76, y: 95 },
      { id: 'east', x: 224, y: 95 },
    ].flatMap((sd) => [
      {
        id: `guild_subdial_ring_${sd.id}`,
        name: `Flanking Sub-Dial Outer Ring (${sd.id.toUpperCase()})`,
        type: 'circle' as const,
        layerId: 'etch',
        x: sd.x,
        y: sd.y,
        r: 14.5,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.35,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: `guild_subdial_inner_${sd.id}`,
        name: `Flanking Sub-Dial Dashed Ring (${sd.id.toUpperCase()})`,
        type: 'circle' as const,
        layerId: 'etch',
        x: sd.x,
        y: sd.y,
        r: 12.2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeDash: 'dashed' as const,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: `guild_subdial_fleur_${sd.id}`,
        name: `Flanking Heraldic Fleur-de-Lis (${sd.id.toUpperCase()})`,
        type: 'path' as const,
        layerId: 'etch',
        x: 0,
        y: 0,
        d: placeArt(ORGANIC_MOTIFS.fleurDeLis, sd.x, sd.y, 18, 18),
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
    ]),
    // Fitted Botanical Rinceau Branches Flanking the Escapement Wheel
    ...(leftLaurelD
      ? [
          {
            id: 'guild_laurel_left',
            name: 'West Botanical Rinceau Branch',
            type: 'path' as const,
            layerId: 'etch',
            x: 54,
            y: 116,
            d: leftLaurelD,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.26,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    ...(rightLaurelD
      ? [
          {
            id: 'guild_laurel_right',
            name: 'East Botanical Rinceau Branch',
            type: 'path' as const,
            layerId: 'etch',
            x: 198,
            y: 116,
            d: rightLaurelD,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.26,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    // Lower guild motto & divider rule
    {
      id: 'guild_motto_rule',
      name: 'Footer Banner Divider Rule',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 72 142 L 228 142 M 72 157 L 228 157',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'guild_motto_text',
      name: 'Guild Foundation Banner Text',
      type: 'text',
      layerId: 'etch',
      x: 82,
      y: 146.5,
      text: 'MASTER WATCHMAKERS • EST. 1884',
      fontFamily: 'Outfit',
      fontSize: 5.5,
      fontWeight: '700',
      letterSpacing: 1.1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: etchColor,
      machining: 'filled',
      hatchOutline: true,
      visible: true,
      locked: false,
    },
  ];

  // Add 12 radial hour indices inside the chapter ring (r = 26..30)
  for (let h = 0; h < 12; h++) {
    const rad = (h * 30 * Math.PI) / 180;
    const r1 = 26.2;
    const r2 = 29.8;
    elements.push({
      id: `guild_hour_tick_${h}`,
      name: `Chapter Ring Hour Index ${h === 0 ? 12 : h}`,
      type: 'line',
      layerId: 'etch',
      x: +(150 + r1 * Math.cos(rad)).toFixed(2),
      y: +(99 + r1 * Math.sin(rad)).toFixed(2),
      x2: +((r2 - r1) * Math.cos(rad)).toFixed(2),
      y2: +((r2 - r1) * Math.sin(rad)).toFixed(2),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: h % 3 === 0 ? 0.45 : 0.28,
      strokeColor: etchColor,
      visible: true,
      locked: false,
    });
  }

  return elements;
}

function generateFlatpackStandElements(): EtchElement[] {
  const cutColor = '#ef4444';
  const etchColor = '#3b82f6';

  const buildUprightFrame = (ox: number, objId: string, partLabel: string, idPrefix: string): EtchElement[] => [
    // Contoured A-frame upright profile with phone cradle lip and 3.2mm cross-slot
    {
      id: `${idPrefix}_profile`,
      name: `${partLabel} Outer Contour`,
      type: 'path',
      layerId: 'cut',
      objectId: objId,
      x: 0,
      y: 0,
      d: `M ${ox} 174 L ${ox} 32 A 6 6 0 0 1 ${ox + 6} 26 L ${ox + 14} 26 A 6 6 0 0 1 ${ox + 19.5} 29.5 L ${ox + 68} 138 L ${ox + 76} 138 A 4 4 0 0 1 ${ox + 80} 142 L ${ox + 80} 158 A 4 4 0 0 1 ${ox + 76} 162 L ${ox + 66} 162 L ${ox + 66} 151 L ${ox + 58} 151 L ${ox + 58} 174 L ${ox + 38} 174 L ${ox + 38} 152 L ${+(ox + 34.8).toFixed(1)} 152 L ${+(ox + 34.8).toFixed(1)} 174 Z`,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Upper truss window aligned parallel to the spine and 65° backrest slope
    {
      id: `${idPrefix}_window_top`,
      name: `${partLabel} Upper Truss Cutout`,
      type: 'path',
      layerId: 'cut',
      objectId: objId,
      x: 0,
      y: 0,
      d: `M ${ox + 8} 42 L ${ox + 15} 42 L ${ox + 36} 89 L ${ox + 8} 89 Z`,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Lower truss window aligned parallel to the spine, diagonal strut, and backrest slope
    {
      id: `${idPrefix}_window_bot`,
      name: `${partLabel} Lower Truss Cutout`,
      type: 'path',
      layerId: 'cut',
      objectId: objId,
      x: 0,
      y: 0,
      d: `M ${ox + 8} 97 L ${ox + 39.5} 97 L ${ox + 56} 134 L ${ox + 8} 134 Z`,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Structural rib outline & angle callout
    {
      id: `${idPrefix}_rib_etch`,
      name: `${partLabel} Structural Web Line`,
      type: 'path',
      layerId: 'etch',
      objectId: objId,
      x: 0,
      y: 0,
      d: `M ${ox + 4} 34 L ${ox + 4} 166 M ${ox + 8} 142 L ${ox + 52} 142`,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: `${idPrefix}_label`,
      name: `${partLabel} Spec Engraving`,
      type: 'text',
      layerId: 'etch',
      objectId: objId,
      x: ox + 8,
      y: 145,
      text: partLabel,
      fontFamily: 'Fira Code',
      fontSize: 3.4,
      fontWeight: '700',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
  ];

  const elements: EtchElement[] = [
    ...buildUprightFrame(22, 'obj_stand_left', 'PART A // 65°', 'stand_left'),
    ...buildUprightFrame(116, 'obj_stand_right', 'PART B // 65°', 'stand_right'),

    // === Object 3: Crossbar & Cable Caddy (x: 212..282, y: 34..166) ===
    {
      id: 'stand_crossbar_cut',
      name: 'Crossbar Interlock Plate',
      type: 'path',
      layerId: 'cut',
      objectId: 'obj_stand_cross',
      x: 0,
      y: 0,
      // Slotted cross-brace with rounded corners and bottom USB-C cable pass-through arch
      d: 'M 218 36 L 276 36 A 4 4 0 0 1 280 40 L 280 160 A 4 4 0 0 1 276 164 L 256 164 L 256 140 A 9 9 0 0 0 238 140 L 238 164 L 218 164 A 4 4 0 0 1 214 160 L 214 136 L 236 136 L 236 132.8 L 214 132.8 L 214 67.2 L 236 67.2 L 236 64 L 214 64 L 214 40 A 4 4 0 0 1 218 36 Z',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // Passive speaker chamber slots in the crossbar
    ...[46, 53].map((sy, idx) => ({
      id: `stand_crossbar_vent_${idx}`,
      name: `Acoustic Resonance Slot ${idx + 1}`,
      type: 'rect' as const,
      layerId: 'cut',
      objectId: 'obj_stand_cross',
      x: 226,
      y: sy,
      w: 42,
      h: 3.2,
      rx: 1.6,
      ry: 1.6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.2,
      strokeColor: cutColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    })),
    {
      id: 'stand_crossbar_frame',
      name: 'Crossbar Graphic Frame',
      type: 'rect',
      layerId: 'etch',
      objectId: 'obj_stand_cross',
      x: 222,
      y: 74,
      w: 52,
      h: 50,
      rx: 3,
      ry: 3,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'stand_crossbar_title',
      name: 'Crossbar Brand Engraving',
      type: 'text',
      layerId: 'etch',
      objectId: 'obj_stand_cross',
      x: 226,
      y: 88,
      text: 'PHYSBOX DOCK',
      fontFamily: 'Orbitron',
      fontSize: 4.6,
      fontWeight: '800',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'stand_crossbar_sub',
      name: 'Crossbar Cable Callout',
      type: 'text',
      layerId: 'etch',
      objectId: 'obj_stand_cross',
      x: 227,
      y: 102,
      text: 'USB-C PASS // 3.0MM',
      fontFamily: 'Fira Code',
      fontSize: 3.1,
      fontWeight: '600',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.25,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
  ];

  return elements;
}

function generateSlateCharcuterieElements(): EtchElement[] {
  const etchColor = '#3b82f6';
  const fillColor = '#10b981';

  const guillocheSpec = ornamentById('guilloche');
  const borderRosetteD = guillocheSpec
    ? guillocheSpec.build(
        { x: 0, y: 0, width: 78, height: 78 },
        { figure: 'rosette', rings: 1, lobes: 18, depth: 0.13, turns: 5, ripple: 0.05, spacing: 3.5 }
      )
    : '';

  const foliageSpec = ornamentById('foliage');
  const topVineD = foliageSpec
    ? foliageSpec.build(
        { x: 0, y: 0, width: 140, height: 24 },
        { scrolls: 4, leafEvery: 4, leafSizeMm: 9.5, tendrils: 2, stemWidthMm: 0.65, spread: 0.24, midrib: 'on', symmetry: 'mirror', seed: 19 }
      )
    : '';
  // Flip the top rinceau vine vertically across its 24mm height for the bottom footer border
  const botVineD = topVineD ? transformPathD(topVineD, [1, 0, 0, -1, 0, 24], 2) : '';

  const zones = [
    { id: 'tl', x: 26, y: 50, title: 'AGED MANCHEGO', tx: 34, sub: 'RAW SHEEP MILK • SPAIN', sx: 36 },
    { id: 'tr', x: 192, y: 50, title: 'TRUFFLE BRIE', tx: 205, sub: 'SOFT RIPENED • FRANCE', sx: 203 },
    { id: 'bl', x: 26, y: 118, title: 'PROSCIUTTO', tx: 40, sub: 'CURED 24 MO • PARMA', sx: 37 },
    { id: 'br', x: 192, y: 118, title: 'FIGS & HONEY', tx: 204, sub: 'WILDFLOWER & WALNUT', sx: 202 },
  ];

  return [
    // Outer double border on the 300x200mm slate slab (no cut layer: slate is surface-only)
    {
      id: 'slate_border_outer',
      name: 'Outer Slate Frame Line',
      type: 'rect',
      layerId: 'etch',
      x: 14,
      y: 14,
      w: 272,
      h: 172,
      rx: 6,
      ry: 6,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.45,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'slate_border_inner',
      name: 'Inner Dashed Tasting Border',
      type: 'rect',
      layerId: 'etch',
      x: 18,
      y: 18,
      w: 264,
      h: 164,
      rx: 4,
      ry: 4,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeDash: 'dashed',
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // 4 Corner Scrollwork Spandrels
    ...[
      { id: 'tl', x: 32, y: 32, rot: -45, fx: 1 as const, fy: 1 as const },
      { id: 'tr', x: 268, y: 32, rot: 45, fx: -1 as const, fy: 1 as const },
      { id: 'bl', x: 32, y: 168, rot: 45, fx: 1 as const, fy: -1 as const },
      { id: 'br', x: 268, y: 168, rot: -45, fx: -1 as const, fy: -1 as const },
    ].map((c) => ({
      id: `slate_corner_scroll_${c.id}`,
      name: `Corner Scroll Flourish (${c.id.toUpperCase()})`,
      type: 'path' as const,
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.scrollFlourish, c.x, c.y, 20, 16, c.rot, c.fx, c.fy),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    })),
    // Mirrored Rinceau Vine Scrollwork Header & Footer (foliage ornament engine)
    ...(topVineD
      ? [
          {
            id: 'slate_foliage_top',
            name: 'Top Botanical Rinceau Vine Scrollwork',
            type: 'path' as const,
            layerId: 'etch',
            d: topVineD,
            x: 80,
            y: 20,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.28,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
          {
            id: 'slate_foliage_top_finial',
            name: 'Top Vine Center Lotus Finial',
            type: 'path' as const,
            layerId: 'etch',
            d: placeArt(ORGANIC_MOTIFS.lotusBloom, 150, 29, 14, 11),
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.28,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    ...(botVineD
      ? [
          {
            id: 'slate_foliage_bot',
            name: 'Bottom Botanical Rinceau Vine Scrollwork',
            type: 'path' as const,
            layerId: 'etch',
            d: botVineD,
            x: 80,
            y: 156,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.28,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
          {
            id: 'slate_foliage_bot_finial',
            name: 'Bottom Vine Center Lotus Finial',
            type: 'path' as const,
            layerId: 'etch',
            d: placeArt(ORGANIC_MOTIFS.lotusBloom, 150, 171, 14, 11, 0, 1, -1),
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.28,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    // Center Medallion Ring, Multi-Turn Guilloche Filigree Rim & Crest
    {
      id: 'slate_center_ring_outer',
      name: 'Center Crest Outer Bezel',
      type: 'circle',
      layerId: 'etch',
      x: 150,
      y: 100,
      r: 40,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.4,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    ...(borderRosetteD
      ? [
          {
            id: 'slate_center_guilloche',
            name: 'Center Crest Rose-Engine Filigree Rim',
            type: 'path' as const,
            layerId: 'etch',
            d: borderRosetteD,
            x: 111,
            y: 61,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.22,
            strokeColor: etchColor,
            fillColor: 'none',
            visible: true,
            locked: false,
          },
        ]
      : []),
    {
      id: 'slate_center_ring',
      name: 'Center Crest Inner Ring',
      type: 'circle',
      layerId: 'etch',
      x: 150,
      y: 100,
      r: 29,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.35,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'slate_center_fleur',
      name: 'Crest Heraldic Fleur-de-Lis',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.fleurDeLis, 150, 78, 12, 12),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'slate_center_title',
      name: 'Charcuterie Crest Script',
      type: 'text',
      layerId: 'fill',
      x: 123,
      y: 85.5,
      text: 'Charcuterie',
      fontFamily: 'Pacifico',
      fontSize: 9.6,
      fontWeight: '400',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: fillColor,
      fillColor: fillColor,
      machining: 'filled',
      hatchAngle: 45,
      hatchSpacing: 0.5,
      hatchOutline: true,
      visible: true,
      locked: false,
    },
    {
      id: 'slate_center_rule',
      name: 'Center Crest Divider Diamond',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: 'M 129 103 L 146 103 M 150 100.8 L 152.2 103 L 150 105.2 L 147.8 103 Z M 154 103 L 171 103',
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.28,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'slate_center_sub',
      name: 'Artisan Subtitle',
      type: 'text',
      layerId: 'etch',
      x: 129.5,
      y: 107.5,
      text: 'ARTISAN SLATE',
      fontFamily: 'Outfit',
      fontSize: 3.3,
      fontWeight: '700',
      letterSpacing: 0.8,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.3,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    {
      id: 'slate_center_lotus',
      name: 'Crest Lower Lotus Flourish',
      type: 'path',
      layerId: 'etch',
      x: 0,
      y: 0,
      d: placeArt(ORGANIC_MOTIFS.lotusBloom, 150, 119.5, 14, 10),
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      strokeWidth: 0.26,
      strokeColor: etchColor,
      fillColor: 'none',
      visible: true,
      locked: false,
    },
    // 4 Framed Tasting-Zone Cartouches with Titles, Rules, & Pairing Notes
    ...zones.flatMap((z) => [
      {
        id: `slate_cartouche_${z.id}`,
        name: `Tasting Zone Cartouche (${z.id.toUpperCase()})`,
        type: 'rect' as const,
        layerId: 'etch',
        x: z.x,
        y: z.y,
        w: 82,
        h: 32,
        rx: 3,
        ry: 3,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.32,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: `slate_rule_${z.id}`,
        name: `Tasting Zone Divider (${z.id.toUpperCase()})`,
        type: 'line' as const,
        layerId: 'etch',
        x: z.x + 8,
        y: z.y + 17,
        x2: 66,
        y2: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeColor: etchColor,
        visible: true,
        locked: false,
      },
      {
        id: `slate_zone_${z.id}`,
        name: `Tasting Zone Title (${z.id.toUpperCase()})`,
        type: 'text' as const,
        layerId: 'etch',
        x: z.tx,
        y: z.y + 6,
        text: z.title,
        fontFamily: 'Outfit',
        fontSize: 5.0,
        fontWeight: '700',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.3,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
      {
        id: `slate_sub_${z.id}`,
        name: `Tasting Zone Origin Note (${z.id.toUpperCase()})`,
        type: 'text' as const,
        layerId: 'etch',
        x: z.sx,
        y: z.y + 21,
        text: z.sub,
        fontFamily: 'Fira Code',
        fontSize: 2.9,
        fontWeight: '600',
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        strokeWidth: 0.25,
        strokeColor: etchColor,
        fillColor: 'none',
        visible: true,
        locked: false,
      },
    ]),
  ];
}

export const PRESET_ETCHINGS: EtchPreset[] = [
  {
    id: 'blank',
    name: 'Blank Document',
    category: 'Start Here',
    description: 'An empty 300x200mm sheet with a cut and an etch layer, ready to draw on.',
    doc: {
      id: 'doc_blank',
      name: 'Untitled',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Blank Document
- Empty 300x200mm sheet on 3mm plywood.
- **Cut Layer (Red)**: through-cut contours.
- **Etch Layer (Blue)**: surface engraving.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: []
    }
  },
  {
    id: 'hotel-keychain',
    name: 'Laser Cut Hotel & Luggage Keychain',
    category: 'Badges & Tags',
    description: 'Vintage diamond key tag with laser cut mounting hole, outer border cut, and engraved custom text.',
    doc: {
      id: 'doc_hotel_keychain',
      name: 'Vintage Hotel Key Tag',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      /**
       * The stock each preset is drawn for, as data rather than as prose.
       *
       * This one's notecard has always said "3 mm Birch Plywood", but nothing
       * read it, so the document fell back to the app-wide default of 6 mm and
       * a 3 mm cut depth that no longer went through. A preset that recommends
       * a material should *be* set to that material — feeds, spindle speed and
       * pass count are all derived from it now, so it is part of the design and
       * not a note attached to one.
       */
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Vintage Hotel Key Tag Preset
- **Cut Layer (Red)**: Outer diamond outline (80x45mm) & 5mm key-ring mounting hole.
- **Etch Layer (Blue)**: Decorative inner border, corner filigree & centred room number typography.
- **Recommended Material**: 3mm Birch Plywood or Acrylic.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Keyring hole
        { id: 'hole_1', name: 'Keyring Hole', type: 'circle', layerId: 'cut', x: 70, y: 100, r: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Outer tag diamond / rounded rect
        { id: 'tag_outer', name: 'Tag Outer Boundary', type: 'rect', layerId: 'cut', x: 60, y: 75, w: 90, h: 50, rx: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Inner etch border
        { id: 'tag_border', name: 'Inner Etch Border', type: 'rect', layerId: 'etch', x: 64, y: 79, w: 82, h: 42, rx: 5, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', strokeDash: 'solid', fillColor: 'none', visible: true, locked: false },
        /**
         * Both lines are centred on x = 110, which is the middle of the space
         * the border leaves *after* the key-ring hole — not the middle of the
         * tag. Text has no anchor here: `x` is the left edge of the first
         * glyph, so centring means subtracting half the measured advance width
         * of the string in its own font and weight (Orbitron 800 at 10 mm is
         * 60.2 mm wide, Outfit 600 at 6 mm is 48.2 mm). Eyeballed values are
         * what left the two lines starting at 80 and 78 and reading as a
         * mistake. Change the words or the size and these numbers must be
         * re-measured, or the lines drift apart again.
         */
        // Text "ROOM 404" — 60.2 mm wide, so 110 - 30.1
        { id: 'text_room', name: 'Room Number Text', type: 'text', layerId: 'etch', x: 79.9, y: 98.5, text: 'ROOM 404', fontFamily: 'Orbitron', fontSize: 10, fontWeight: '800', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: '#3b82f6', machining: 'filled', hatchOutline: false, visible: true, locked: false },
        // Text "PHYSBOX HOTEL" — 48.2 mm wide, so 110 - 24.1
        { id: 'text_hotel', name: 'Hotel Title Text', type: 'text', layerId: 'etch', x: 85.9, y: 89.5, text: 'PHYSBOX HOTEL', fontFamily: 'Outfit', fontSize: 6, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: '#3b82f6', machining: 'filled', hatchOutline: false, visible: true, locked: false },
        /**
         * Filigree. Every ornament is a closed outline rather than a stroked
         * squiggle: an etch layer cuts the path it is given, and a hairline
         * scroll drawn as a single open line comes off the machine as one thin
         * scratch instead of a shape with a thick and a thin end.
         *
         * The corner curls sit 3.5 mm inside the etched border so the two lines
         * stay separate at the 0.2 mm kerf of a diode laser, and the pair of
         * leaves flanks the title in the 8 mm the shortened title line leaves
         * on each side.
         */
        { id: 'curl_tl', name: 'Corner Curl (Top Left)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 74 81.6 C 70 81.6 67.6 83.2 67.6 87 C 68.6 84.6 70.4 83.6 73 83.4 C 71.6 82.8 71.6 82 74 81.6 Z', visible: true, locked: false },
        { id: 'curl_tr', name: 'Corner Curl (Top Right)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 136 81.6 C 140 81.6 142.4 83.2 142.4 87 C 141.4 84.6 139.6 83.6 137 83.4 C 138.4 82.8 138.4 82 136 81.6 Z', visible: true, locked: false },
        { id: 'curl_bl', name: 'Corner Curl (Bottom Left)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 74 118.4 C 70 118.4 67.6 116.8 67.6 113 C 68.6 115.4 70.4 116.4 73 116.6 C 71.6 117.2 71.6 118 74 118.4 Z', visible: true, locked: false },
        { id: 'curl_br', name: 'Corner Curl (Bottom Right)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 136 118.4 C 140 118.4 142.4 116.8 142.4 113 C 141.4 115.4 139.6 116.4 137 116.6 C 138.4 117.2 138.4 118 136 118.4 Z', visible: true, locked: false },
        { id: 'leaf_l', name: 'Title Flourish (Left)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 78.2 93.5 C 80 91.9 82.2 92.1 84.2 93.5 C 82.2 94.9 80 95.1 78.2 93.5 Z', visible: true, locked: false },
        { id: 'leaf_r', name: 'Title Flourish (Right)', type: 'path', layerId: 'etch', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', d: 'M 141.8 93.5 C 140 91.9 137.8 92.1 135.8 93.5 C 137.8 94.9 140 95.1 141.8 93.5 Z', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'mandala-coaster',
    name: 'Sacred Geometry Mandala Coaster',
    category: 'Coasters & Art',
    description: '100mm circular coaster with intricate 8-fold lotus geometry, concentric etch rings, and cut boundary.',
    doc: {
      id: 'doc_mandala_coaster',
      name: 'Sacred Mandala Coaster',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Sacred Mandala Coaster Preset
- **Cut Layer**: 100mm outer coaster boundary.
- **Etch Layer**: Concentric sacred geometry rings and 8-fold lotus petal array.
- **Mandala Tools**: Double click or use Mandala Tool sidebar to generate customized radial symmetry!`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 30, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Outer Coaster Cut Circle
        { id: 'coaster_cut', name: 'Coaster Outer Cut', type: 'circle', layerId: 'cut', x: 150, y: 100, r: 48, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Outer Etch Ring
        { id: 'coaster_ring1', name: 'Outer Etch Ring', type: 'circle', layerId: 'etch', x: 150, y: 100, r: 44, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Inner Etch Ring
        { id: 'coaster_ring2', name: 'Inner Etch Ring', type: 'circle', layerId: 'etch', x: 150, y: 100, r: 20, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Center Star / Mandala petals
        { id: 'center_star', name: 'Center Star', type: 'polygon', layerId: 'etch', x: 150, y: 100, sides: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'intricate-mandala-art',
    name: 'Grand Intricate Mandala Wall Medallion',
    category: 'Coasters & Art',
    description: '184mm multi-tiered sacred mandala medallion featuring 16-fold lotus petals with teardrop filigree, 24-point starburst rays, raster-hatched lotus core, and wall mount cutout.',
    doc: {
      id: 'doc_intricate_mandala',
      name: 'Grand Intricate Mandala',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Grand Intricate Mandala Wall Medallion Preset
- **Cut Layer (Red)**: 184mm outer medallion boundary & 5mm top wall mounting cutout.
- **Etch Layer (Blue)**: Multi-tiered 16-fold lotus petals with inner teardrop filigree, 24-point starburst rays, and 12-point interlocking sacred geometry stars.
- **Fill Layer (Green)**: 45° raster-hatched 8-point lotus star core for rich contrast laser engraving.
- **Recommended Material**: 3mm Birch Plywood, Basswood, Walnut, or Dual-Tone Acrylic.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 30, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2400, power: 45, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: generateIntricateMandalaElements(150, 100),
    }
  },
  {
    id: 'box-joint-panel',
    name: 'Finger-Joint Box Lid (140x100mm)',
    category: 'Enclosures & Boxes',
    description: 'Precision laser cut box lid with finger joint tabs (3mm stock), ventilation slots, and engrave label space.',
    doc: {
      id: 'doc_box_joint',
      name: 'Finger Joint Box Panel',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Finger Joint Panel Preset
- **Finger Tabs**: 10mm width tabs around the 140x100mm perimeter spaced for 3mm material interlocking.
- **Kerf Compensation**: Set kerf width in G-code exporter for friction-fit joints.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 450, power: 95, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Box outer tabbed boundary path (10mm finger tabs for 3mm stock)
        {
          id: 'box_outline',
          name: 'Finger Joint Cut Boundary',
          type: 'path',
          layerId: 'cut',
          x: 0,
          y: 0,
          d: 'M 50 40 L 60 40 L 60 37 L 70 37 L 70 40 L 80 40 L 80 37 L 90 37 L 90 40 L 100 40 L 100 37 L 110 37 L 110 40 L 120 40 L 120 37 L 130 37 L 130 40 L 140 40 L 140 37 L 150 37 L 150 40 L 160 40 L 160 37 L 170 37 L 170 40 L 180 40 L 180 37 L 190 37 L 190 40 L 190 50 L 193 50 L 193 60 L 190 60 L 190 70 L 193 70 L 193 80 L 190 80 L 190 90 L 193 90 L 193 100 L 190 100 L 190 110 L 193 110 L 193 120 L 190 120 L 190 130 L 193 130 L 193 140 L 190 140 L 180 140 L 180 143 L 170 143 L 170 140 L 160 140 L 160 143 L 150 143 L 150 140 L 140 140 L 140 143 L 130 143 L 130 140 L 120 140 L 120 143 L 110 143 L 110 140 L 100 140 L 100 143 L 90 143 L 90 140 L 80 140 L 80 143 L 70 143 L 70 140 L 60 140 L 60 143 L 50 143 L 50 140 L 50 130 L 47 130 L 47 120 L 50 120 L 50 110 L 47 110 L 47 100 L 50 100 L 50 90 L 47 90 L 47 80 L 50 80 L 50 70 L 47 70 L 47 60 L 50 60 L 50 50 L 47 50 L 47 40 L 50 40 Z',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // Vent slots
        { id: 'vent_1', name: 'Vent Slot 1', type: 'rect', layerId: 'cut', x: 75, y: 65, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'vent_2', name: 'Vent Slot 2', type: 'rect', layerId: 'cut', x: 75, y: 75, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'vent_3', name: 'Vent Slot 3', type: 'rect', layerId: 'cut', x: 75, y: 85, w: 90, h: 4, rx: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Engraved Label Text
        { id: 'text_box_label', name: 'Box Label Text', type: 'text', layerId: 'etch', x: 90, y: 110, text: 'ELECTRONICS BAY', fontFamily: 'Fira Code', fontSize: 7, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'spur-gear-set',
    name: 'Spur Gear & Pinion Set (2:1 Ratio)',
    category: 'Mechanical Parts',
    description: 'Meshing 20-tooth driven spur gear and 10-tooth drive pinion using parametric gear geometry, D-shaft keyway bore, curved radial sector spokes, and pitch circle references.',
    doc: {
      id: 'doc_spur_gear',
      name: '2:1 Spur Gear & Pinion Set',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 4,
      notecard: `### Spur Gear & Pinion Set (2:1 Ratio)
- **Parametric Gears**: Both the 20-tooth driven gear and 10-tooth drive pinion use live parametric \`shape: 'gear'\` elements — select either gear to adjust tooth count or root radius in the inspector.
- **2:1 Reduction**: Pitch radii of 40mm and 20mm with dashed pitch circles, hub collars, and 5 curved annular sector cutouts on the driven wheel.
- **Grouped Parts**: Grouped into two \`EtchObject\` assemblies so each gear moves and nests as a unit.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 400, power: 100, passes: 1, zDepth: 4.3 },
        { id: 'etch', name: 'Pitch Circle Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2200, power: 25, passes: 1, zDepth: 0.5 },
      ],
      objects: [
        { id: 'obj_gear_driven', name: '20T Driven Gear' },
        { id: 'obj_gear_pinion', name: '10T Drive Pinion' },
      ],
      selectedIds: [],
      elements: [
        // === 20T Driven Gear (centered at x: 96, y: 100) ===
        {
          id: 'gear_teeth',
          name: '20T Driven Spur Gear Contour',
          type: 'star',
          shape: 'gear',
          layerId: 'cut',
          objectId: 'obj_gear_driven',
          x: 96,
          y: 100,
          pointsCount: 20,
          innerRadius: 36,
          outerRadius: 44,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // Center D-shaft Bore (8mm with flat keyway)
        {
          id: 'shaft_hole',
          name: 'Center D-Shaft Bore (8mm)',
          type: 'path',
          layerId: 'cut',
          objectId: 'obj_gear_driven',
          x: 96,
          y: 100,
          d: 'M -2.8 -2.9 A 4 4 0 1 0 2.8 -2.9 Z',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // 5 Curved Annular Sector Lightening Windows (r = 13.5..29.5mm)
        ...[0, 1, 2, 3, 4].map((k) => {
          const cx = 96;
          const cy = 100;
          const rIn = 13.5;
          const rOut = 29.5;
          const a0 = ((k * 72 + 13) * Math.PI) / 180;
          const a1 = ((k * 72 + 59) * Math.PI) / 180;
          const x0i = +(cx + rIn * Math.cos(a0)).toFixed(2);
          const y0i = +(cy + rIn * Math.sin(a0)).toFixed(2);
          const x0o = +(cx + rOut * Math.cos(a0)).toFixed(2);
          const y0o = +(cy + rOut * Math.sin(a0)).toFixed(2);
          const x1o = +(cx + rOut * Math.cos(a1)).toFixed(2);
          const y1o = +(cy + rOut * Math.sin(a1)).toFixed(2);
          const x1i = +(cx + rIn * Math.cos(a1)).toFixed(2);
          const y1i = +(cy + rIn * Math.sin(a1)).toFixed(2);
          return {
            id: `gear_sector_${k}`,
            name: `Spoke Sector Window ${k + 1}`,
            type: 'path' as const,
            layerId: 'cut',
            objectId: 'obj_gear_driven',
            x: 0,
            y: 0,
            d: `M ${x0i} ${y0i} L ${x0o} ${y0o} A ${rOut} ${rOut} 0 0 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rIn} ${rIn} 0 0 0 ${x0i} ${y0i} Z`,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.2,
            strokeColor: '#ef4444',
            fillColor: 'none',
            visible: true,
            locked: false,
          };
        }),
        // Driven Gear Pitch Circle Reference (40mm), Rim Ring (33mm), & Hub Collar Ring (10.5mm)
        { id: 'pitch_circle', name: 'Driven Pitch Circle (R40)', type: 'circle', layerId: 'etch', objectId: 'obj_gear_driven', x: 96, y: 100, r: 40, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', strokeDash: 'dashed', fillColor: 'none', visible: true, locked: false },
        { id: 'gear_rim_ring', name: 'Driven Web Rim Ring (R33)', type: 'circle', layerId: 'etch', objectId: 'obj_gear_driven', x: 96, y: 100, r: 33, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        { id: 'gear_hub_ring', name: 'Driven Hub Collar Ring (R10.5)', type: 'circle', layerId: 'etch', objectId: 'obj_gear_driven', x: 96, y: 100, r: 10.5, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },

        // === 10T Drive Pinion (centered at x: 184, y: 100 — clean 20mm cut clearance from 20T gear) ===
        {
          id: 'pinion_teeth',
          name: '10T Drive Pinion Contour',
          type: 'star',
          shape: 'gear',
          layerId: 'cut',
          objectId: 'obj_gear_pinion',
          x: 184,
          y: 100,
          pointsCount: 10,
          innerRadius: 16,
          outerRadius: 24,
          rotation: 18,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'pinion_shaft_hole',
          name: 'Pinion Motor D-Shaft Bore (5mm)',
          type: 'path',
          layerId: 'cut',
          objectId: 'obj_gear_pinion',
          x: 184,
          y: 100,
          d: 'M -1.8 -1.8 A 2.5 2.5 0 1 0 1.8 -1.8 Z',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.2,
          strokeColor: '#ef4444',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // 4x Pinion Web Lightening Holes
        ...[0, 1, 2, 3].map((k) => {
          const rad = ((k * 90 + 45) * Math.PI) / 180;
          return {
            id: `pinion_web_${k}`,
            name: `Pinion Web Hole ${k + 1}`,
            type: 'circle' as const,
            layerId: 'cut',
            objectId: 'obj_gear_pinion',
            x: +(184 + 9.2 * Math.cos(rad)).toFixed(2),
            y: +(100 + 9.2 * Math.sin(rad)).toFixed(2),
            r: 2.6,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
            strokeWidth: 0.2,
            strokeColor: '#ef4444',
            fillColor: 'none',
            visible: true,
            locked: false,
          };
        }),
        {
          id: 'pinion_pitch_circle',
          name: 'Pinion Pitch Circle (R20)',
          type: 'circle',
          layerId: 'etch',
          objectId: 'obj_gear_pinion',
          x: 184,
          y: 100,
          r: 20,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.3,
          strokeColor: '#3b82f6',
          strokeDash: 'dashed',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'pinion_hub_ring',
          name: 'Pinion Hub Ring (R13.5)',
          type: 'circle',
          layerId: 'etch',
          objectId: 'obj_gear_pinion',
          x: 184,
          y: 100,
          r: 13.5,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.28,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // Transmission Spec Legend Plaque on Right Side
        {
          id: 'gear_spec_frame',
          name: 'Transmission Spec Plaque',
          type: 'rect',
          layerId: 'etch',
          x: 218,
          y: 72,
          w: 64,
          h: 56,
          rx: 3,
          ry: 3,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.3,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'gear_spec_title',
          name: 'Gear Ratio Title',
          type: 'text',
          layerId: 'etch',
          x: 224,
          y: 80,
          text: 'RATIO 2:1',
          fontFamily: 'Orbitron',
          fontSize: 5.2,
          fontWeight: '800',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.3,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'gear_spec_sub1',
          name: 'Driven Gear Spec',
          type: 'text',
          layerId: 'etch',
          x: 224,
          y: 94,
          text: 'DRIVEN: 20T (R40)',
          fontFamily: 'Fira Code',
          fontSize: 3.2,
          fontWeight: '600',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.25,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'gear_spec_sub2',
          name: 'Pinion Gear Spec',
          type: 'text',
          layerId: 'etch',
          x: 224,
          y: 104,
          text: 'PINION: 10T (R20)',
          fontFamily: 'Fira Code',
          fontSize: 3.2,
          fontWeight: '600',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.25,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        {
          id: 'gear_spec_sub3',
          name: 'Center Distance Spec',
          type: 'text',
          layerId: 'etch',
          x: 224,
          y: 114,
          text: 'MESH CD: 60.0MM',
          fontFamily: 'Fira Code',
          fontSize: 3.2,
          fontWeight: '600',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.25,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
      ]
    }
  },
  {
    id: 'wooden-desk-sign',
    name: 'Ornate Wooden Desk Sign',
    category: 'Signs & Typography',
    description: 'Decorative desk sign with ribbon banner, botanical leaf motifs, and elegant typography.',
    doc: {
      id: 'doc_desk_sign',
      name: 'Ornate Desk Sign',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Ornate Desk Sign Preset
- Perfect for wood carving on a CNC mill or laser raster engraving.`,
      layers: [
        { id: 'cut', name: 'Sign Outer Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Typography Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2000, power: 40, passes: 1, zDepth: 0.5 },
      ],
      selectedIds: [],
      elements: [
        // Sign Outer Boundary
        { id: 'sign_rect', name: 'Outer Cut Frame', type: 'rect', layerId: 'cut', x: 40, y: 50, w: 220, h: 100, rx: 12, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Inner Etch Line
        { id: 'sign_inner_frame', name: 'Inner Etch Line', type: 'rect', layerId: 'etch', x: 46, y: 56, w: 208, h: 88, rx: 8, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.4, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Main Title Text "PHYSBOX ETCH"
        { id: 'sign_title', name: 'Sign Main Title', type: 'text', layerId: 'etch', x: 65, y: 95, text: 'PHYSBOX ETCH', fontFamily: 'Pacifico', fontSize: 18, fontWeight: '400', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Subtitle "CREATIVE VECTOR STUDIO"
        { id: 'sign_subtitle', name: 'Sign Subtitle', type: 'text', layerId: 'etch', x: 95, y: 118, text: 'CREATIVE VECTOR STUDIO', fontFamily: 'Outfit', fontSize: 6, fontWeight: '600', letterSpacing: 2, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'cyberpunk-badge',
    name: 'Cyberpunk Circuit Badge',
    category: 'Badges & Tags',
    description: 'Sci-fi hexagonal shield circuit badge featuring 32-pin IC microprocessor, 45° PCB trace network, SMD resistor pads, reticle & hazard icons, raster pocket fills, and mounting holes/lanyard slot.',
    doc: {
      id: 'doc_cyber_badge',
      name: 'Cyberpunk Circuit Badge',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Cyberpunk Circuit Badge Preset
- **Cut Layer (Red)**: Sci-Fi Chamfered Shield Boundary, 24x4mm Lanyard Slot, & 4x M3 Corner Mounting Holes.
- **Etch Layer (Blue)**: 32-Pin QFP Microprocessor Footprint, 45° PCB Trace Runs with Via Pads, 0805 SMD Component Pads, Reticle Crosshairs, Hazard Icons, & Telemetry Labels.
- **Fill Layer (Green)**: Raster Pocket Fills for Processor Core, Header Bar, and Telemetry Footer.
- **Recommended Material**: 3mm Birch Plywood, Black/Gold Dual-Tone Acrylic, or Matte Anodized Aluminum.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2500, power: 50, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: generateCyberpunkBadgeElements(150, 100),
    }
  },
  {
    id: 'thai-lotus-tile',
    name: 'Thai Lotus Relief Tile (150x150mm)',
    category: 'Coasters & Art',
    description: '150mm carved wooden tile: an eight-fold Thai lotus roundel machined as a shaded relief from a 120mm height map, with water-drop ripples running out from the centre, and eight pierced leaves cut clean through.',
    doc: {
      id: 'doc_thai_tile',
      name: 'Thai Lotus Relief Tile',
      width: 150,
      height: 150,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      machine: 'cnc',
      material: 'hardwood',
      stockThickness: 10,
      notecard: `### Thai Lotus Relief Tile
- **Relief Layer (Purple)**: the 120mm lotus roundel as a shaded image. Greys are *heights* — white is the untouched board, black is the back of the board — so the ground carves 5.5mm and the flower stands 5.2mm proud of it, with water-drop rings running out from the centre — 2mm deep at the first, 1.5mm at the second, 1mm from the third out — cut across the whole carving, petals included. The layer depth is the 10mm thickness, so a grey says where in the board that point sits — but nothing here is black, and the passes are planned from the darkest tone the picture actually has. About 80 minutes in 5 passes; a shallower ground is the setting that buys the time back. Roughed with the ¼" flat mill and finished with the 3.175mm ball nose — 24 minutes instead of 78. Clear the roughing tool in the layer panel if you only own one cutter.
- **Cut Layer (Red)**: eight pierced leaves, then the 140mm rounded outline. Through-cuts belong here and not in the picture: the relief's pass count comes from the deepest thing in it, so a hole in the height map would put the whole sweep through seven passes instead of three.
- Pitch, sweep angle, depth and size are all still editable — the element carries the pixels, not a baked toolpath.
- **Recommended Material**: 10mm teak, mahogany or maple. The relief is surface work and runs before anything releases the tile.`,
      layers: [
        { id: 'relief', name: 'Lotus Relief', color: '#a855f7', operation: 'shade', visible: true, locked: false, speed: 1400, power: 80, passes: 1, zDepth: TILE_RELIEF_DEPTH_MM, tool: 5, roughTool: 6 },
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 10.5, tool: 1 },
      ],
      selectedIds: [],
      elements: thaiTileElements(150),
    }
  },
  {
    id: 'living-hinge-journal',
    name: 'Living Hinge Field Journal Cover',
    category: 'Enclosures & Boxes',
    description: 'Wrap-around A6 wooden notebook cover with a parametric torsion-slit living hinge spine, compass rose cover emblem, elastic closure slots, and an engraved 100mm field ruler.',
    doc: {
      id: 'doc_living_hinge_journal',
      name: 'Living Hinge Field Journal',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Living Hinge Field Journal Cover
- **Living Hinge Layer (Sky Blue)**: 36x150mm torsion-slit spine (\`slitLengthMm: 28, bridgeMm: 3, pitchMm: 3.5\`). Dragging the spine's resize handles re-plans the slit lattice at the new dimensions without stretching the torsion beams.
- **Cut Layer (Red)**: 240x150mm wrap-around cover perimeter and top/bottom elastic strap slots.
- **Etch & Fill Layers**: Compass rose cover medallion, front/back framing borders, and a 100mm metric field scale along the back cover.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: HINGE_LAYER_ID, name: 'Living hinge', color: '#0ea5e9', operation: 'cut', visible: true, locked: false, speed: 400, power: 90, passes: 1, zDepth: 3.3, cutSide: 'on', tabs: false },
        { id: 'etch', name: 'Vector Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
        { id: 'fill', name: 'Raster Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2400, power: 45, passes: 1, zDepth: 0.8 },
      ],
      selectedIds: [],
      elements: generateLivingHingeJournalElements(),
    }
  },
  {
    id: 'synth-speaker-grille',
    name: 'Eurorack Synth & Monitor Faceplate',
    category: 'Enclosures & Boxes',
    description: '2mm brushed-aluminium audio module panel featuring a radially ramped hexagonal speaker grille perforation, potentiometer shaft cutouts with dial scales, and 1/4" TRS jack holes.',
    doc: {
      id: 'doc_synth_grille',
      name: 'Synth & Speaker Faceplate',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      machine: 'cnc',
      material: 'aluminium',
      stockThickness: 2,
      notecard: `### Eurorack Synth & Monitor Faceplate
- **Perforation Layer (Teal)**: 108x108mm hexagonal speaker grille with a radial hole-size ramp (\`sizeMm: 5.5, pitchMm: 8, ramp: 'radial'\`) that fades smoothly into the solid 2mm aluminium panel. Resize it on the canvas to re-plan the lattice live.
- **Cut Layer (Red)**: 260x140mm faceplate contour, 4x oblong rack-mount slots, 3x potentiometer shaft holes, and 2x 1/4" audio jack cutouts.
- **Etch & Fill Layers**: Transducer bezel, dial scale collars, hex bushing footprints, and front-panel legends.`,
      layers: [
        { id: 'cut', name: 'Panel & Hardware Cutouts', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 400, power: 95, passes: 1, zDepth: 2.3, tool: 2 },
        { id: PERFORATION_LAYER_ID, name: 'Perforation', color: '#14b8a6', operation: 'cut', visible: true, locked: false, speed: 400, power: 90, passes: 1, zDepth: 2.3, cutSide: 'inside', tabs: false, tool: 2 },
        { id: 'etch', name: 'Panel Legends Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1500, power: 40, passes: 1, zDepth: 0.25, tool: 4 },
        { id: 'fill', name: 'Accent Pocket Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 1800, power: 50, passes: 1, zDepth: 0.3, tool: 2 },
      ],
      selectedIds: [],
      elements: generateSynthGrilleElements(),
    }
  },
  {
    id: 'layered-mountain-diorama',
    name: '3-Sheet Topographic Alpine Shadow Box',
    category: 'Coasters & Art',
    description: 'Multi-sheet 3D layered shadow-box diorama across three 180x180mm sheets (Foreground Pine Frame, Midground Alpine Peaks, and Horizon Sunburst Backing) locked in alignment with 3-pin L-pattern registration holes.',
    doc: generateMountainDioramaPreset(),
  },
  {
    id: 'vcarve-guild-sign',
    name: '3D V-Carved Horology Guild Plaque',
    category: 'Signs & Typography',
    description: '18mm hardwood CNC plaque combining medial-axis 3D V-carved serif typography curved along a ghost guide arc, an engine-turned guilloche dial rosette, and an end-milled scalloped heritage frame.',
    doc: {
      id: 'doc_vcarve_guild_sign',
      name: 'Horology Guild Plaque',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      machine: 'cnc',
      material: 'hardwood',
      stockThickness: 18,
      notecard: `### 3D V-Carved Horology Guild Plaque
- **3D V-Carve Layer (Blue, T3 60° V-Bit)**: Uses \`vCarve3D: true\` (` + '`vCarveMaxDepth: 3.5mm`' + `) to variable-depth bevel the arched title, chamfer border, escapement wheel, and engine-turned guilloche rosette.
- **Text on Path + Ghost Guide (Slate)**: The arched title rides \`guild_arch_guide\` on the non-machined \`ghost\` construction layer.
- **Profile Cut Layer (Red, T1 1/8" End Mill)**: Full-depth scalloped heritage plaque cutout through 18mm hardwood.`,
      layers: [
        { id: 'etch', name: '3D V-Carve Inscription', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1200, power: 40, passes: 1, zDepth: 2.0, tool: 3, vCarve3D: true, vCarveMaxDepth: 3.5 },
        { id: 'cut', name: 'Plaque Profile Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 95, passes: 1, zDepth: 18.3, tool: 1 },
        { id: 'ghost', name: 'Construction Guides', color: '#94a3b8', operation: 'ghost', visible: true, locked: false, speed: 1000, power: 0, passes: 1, zDepth: 0 },
      ],
      selectedIds: [],
      elements: generateVCarveGuildSignElements(),
    }
  },
  {
    id: 'bridged-stencil-topper',
    name: 'Bridged Mylar Crate Stencil',
    category: 'Signs & Typography',
    description: 'Reusable 0.5mm Mylar spray stencil featuring automatically bridged lettering (joinPieces), unburnt contour holding bridges on the cut layer, directional handling arrows, and hazard chevron cutouts.',
    doc: {
      id: 'doc_bridged_stencil',
      name: 'Bridged Mylar Crate Stencil',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'film',
      stockThickness: 0.5,
      notecard: `### Bridged Mylar Crate Stencil
- **Bridged Cut Layer (Red)**: Enables \`bridges: true\` so closed inner islands (like O, A, R, D, and concentric rings) stay tied to the 0.5mm Mylar sheet instead of dropping out onto the laser bed.
- **Joined Text (\`joinPieces: true\`)**: The stencil headlines stay live, editable text while automatically bridging disconnected glyph contours.`,
      layers: [
        { id: 'cut', name: 'Bridged Stencil Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 1400, power: 35, passes: 1, zDepth: 0.8, bridges: true },
        { id: 'etch', name: 'Alignment Marks Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 2400, power: 15, passes: 1, zDepth: 0.1 },
      ],
      selectedIds: [],
      elements: [
        // Outer Mylar Stencil Sheet Cutout (240x150mm)
        { id: 'stencil_sheet_cut', name: 'Stencil Sheet Outer Cut', type: 'rect', layerId: 'cut', x: 30, y: 25, w: 240, h: 150, rx: 6, ry: 6, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // 4 Corner Registration L-Markings (Etch)
        {
          id: 'stencil_corner_marks',
          name: 'Corner Crate Alignment Reticles',
          type: 'path',
          layerId: 'etch',
          x: 0,
          y: 0,
          d: 'M 38 45 L 38 33 L 50 33 M 250 33 L 262 33 L 262 45 M 38 155 L 38 167 L 50 167 M 250 167 L 262 167 L 262 155',
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          strokeWidth: 0.35,
          strokeColor: '#3b82f6',
          fillColor: 'none',
          visible: true,
          locked: false,
        },
        // Top & Bottom Diagonal Hazard Chevron Cutout Bars (7 angled chevrons each)
        ...[0, 1, 2, 3, 4, 5, 6].flatMap((i) => {
          const x0 = 56 + i * 26;
          return [
            {
              id: `stencil_chev_top_${i}`,
              name: `Top Hazard Chevron ${i + 1}`,
              type: 'path' as const,
              layerId: 'cut',
              x: 0,
              y: 0,
              d: `M ${x0} 49 L ${x0 + 6} 40 L ${x0 + 18} 40 L ${x0 + 12} 49 Z`,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              strokeWidth: 0.2,
              strokeColor: '#ef4444',
              fillColor: 'none',
              visible: true,
              locked: false,
            },
            {
              id: `stencil_chev_bot_${i}`,
              name: `Bottom Hazard Chevron ${i + 1}`,
              type: 'path' as const,
              layerId: 'cut',
              x: 0,
              y: 0,
              d: `M ${x0} 160 L ${x0 + 6} 151 L ${x0 + 18} 151 L ${x0 + 12} 160 Z`,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              strokeWidth: 0.2,
              strokeColor: '#ef4444',
              fillColor: 'none',
              visible: true,
              locked: false,
            },
          ];
        }),
        // Left & Right Upward Handling Arrows (rotation: 0 points UP!) + Bridged Stencil Rings
        { id: 'stencil_arrow_ring_l', name: 'Left Arrow Bridged Ring', type: 'circle', layerId: 'cut', x: 64, y: 100, r: 22, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'stencil_arrow_l', name: 'Left Upward Arrow Cutout', type: 'star', shape: 'arrow', layerId: 'cut', x: 64, y: 100, innerRadius: 5.5, outerRadius: 16, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'stencil_arrow_ring_r', name: 'Right Arrow Bridged Ring', type: 'circle', layerId: 'cut', x: 236, y: 100, r: 22, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        { id: 'stencil_arrow_r', name: 'Right Upward Arrow Cutout', type: 'star', shape: 'arrow', layerId: 'cut', x: 236, y: 100, innerRadius: 5.5, outerRadius: 16, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Center Stencil Framing Box
        { id: 'stencil_center_frame', name: 'Center Stencil Alignment Box', type: 'rect', layerId: 'etch', x: 92, y: 58, w: 116, h: 84, rx: 3, ry: 3, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeDash: 'dashed', strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
        // Main Bridged Stencil Headline
        { id: 'stencil_text_main', name: 'Main Stencil Headline', type: 'text', layerId: 'cut', x: 105, y: 66, text: 'FRAGILE', fontFamily: 'Orbitron', fontSize: 16.5, fontWeight: '800', joinPieces: true, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Secondary Bridged Stencil Sub-headline
        { id: 'stencil_text_sub', name: 'Secondary Stencil Subhead', type: 'text', layerId: 'cut', x: 104, y: 98, text: 'THIS SIDE UP', fontFamily: 'Orbitron', fontSize: 10.2, fontWeight: '800', joinPieces: true, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Tertiary Bridged Handling Instruction
        { id: 'stencil_text_care', name: 'Handling Care Stencil Line', type: 'text', layerId: 'cut', x: 105, y: 122, text: 'DO NOT DROP', fontFamily: 'Orbitron', fontSize: 9.8, fontWeight: '800', joinPieces: true, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#ef4444', fillColor: 'none', visible: true, locked: false },
        // Etched Reference Specs along Top Margin
        { id: 'stencil_spec_note', name: 'Stencil Margin Spec Label', type: 'text', layerId: 'etch', x: 88, y: 31, text: 'STENCIL REF: MYLAR-05 // BRIDGES ON', fontFamily: 'Fira Code', fontSize: 3.8, fontWeight: '600', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.3, strokeColor: '#3b82f6', fillColor: 'none', visible: true, locked: false },
      ]
    }
  },
  {
    id: 'flatpack-phone-stand',
    name: 'Flat-Pack Slot-Together Desk Stand',
    category: 'Mechanical Parts',
    description: '3-piece slot-together wooden phone & tablet desk dock organized into named multi-layer EtchObjects (Left Frame, Right Frame, and Crossbar) ready for auto-nesting.',
    doc: {
      id: 'doc_flatpack_stand',
      name: 'Flat-Pack Desk Phone Stand',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'plywood',
      stockThickness: 3,
      notecard: `### Flat-Pack Slot-Together Desk Stand
- **3 Named Objects (\`EtchObject\`)**: Each part (Left Side Frame, Right Side Frame, Crossbar & Cable Caddy) combines its own Cut and Etch elements into a single selectable object.
- **Auto-Pack Ready**: Open **Generators → Pack parts onto stock** to nest the 3 assemblies tightly onto smaller offcuts.
- **3.2mm Interlocking Slots**: Sized for 3mm birch plywood with a USB-C charging cable pass-through notch in the crossbar.`,
      layers: [
        { id: 'cut', name: 'Vector Cut', color: '#ef4444', operation: 'cut', visible: true, locked: false, speed: 500, power: 90, passes: 1, zDepth: 3.3 },
        { id: 'etch', name: 'Part Markings Etch', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1800, power: 35, passes: 1, zDepth: 0.5 },
      ],
      objects: [
        { id: 'obj_stand_left', name: 'Left Side Frame' },
        { id: 'obj_stand_right', name: 'Right Side Frame' },
        { id: 'obj_stand_cross', name: 'Crossbar & Cable Caddy' },
      ],
      selectedIds: [],
      elements: generateFlatpackStandElements(),
    }
  },
  {
    id: 'slate-charcuterie-board',
    name: 'Botanical Slate Charcuterie Board',
    category: 'Coasters & Art',
    description: 'Surface-only laser engraving on an 8mm natural slate slab featuring procedural botanical vine scrollwork, central crest medallion, and four artisan cheese & charcuterie tasting zone callouts.',
    doc: {
      id: 'doc_slate_charcuterie',
      name: 'Botanical Slate Charcuterie Board',
      width: 300,
      height: 200,
      gridSize: 10,
      snapToGrid: true,
      units: 'mm',
      origin: 'top-left',
      material: 'stone',
      stockThickness: 8,
      notecard: `### Botanical Slate Charcuterie Board
- **Surface-Only Stone Profile**: Configured for \`material: 'stone'\` (8mm natural riven slate). Because stone fractures rather than parts under a beam or cutter, this preset contains only surface **Etch** and **Fill** layers.
- **Procedural Botanical Ornaments**: Header and footer vine flourishes are generated via \`ornaments.ts\` (\`foliage\`) and paired with four tasting zone labels.`,
      layers: [
        { id: 'etch', name: 'Slate Line Engraving', color: '#3b82f6', operation: 'etch', visible: true, locked: false, speed: 1600, power: 45, passes: 1, zDepth: 0.3 },
        { id: 'fill', name: 'Crest Raster Fill', color: '#10b981', operation: 'fill', visible: true, locked: false, speed: 2200, power: 55, passes: 1, zDepth: 0.4 },
      ],
      selectedIds: [],
      elements: generateSlateCharcuterieElements(),
    }
  }
];

/**
 * The document the app opens with, and what it falls back to when the active
 * saved document is deleted. Named rather than `PRESET_ETCHINGS[0]` so that
 * reordering the menu — e.g. putting the blank sheet first — does not silently
 * change what a fresh session starts on.
 */
export const DEFAULT_PRESET_ID = 'hotel-keychain';

export const DEFAULT_PRESET: EtchPreset =
  PRESET_ETCHINGS.find((p) => p.id === DEFAULT_PRESET_ID) ?? PRESET_ETCHINGS[0];
