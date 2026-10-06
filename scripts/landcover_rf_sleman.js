/**
 * Land Cover Classification of Sleman Regency (Indonesia) with Google Earth Engine
 * --------------------------------------------------------------------------------
 * Supervised Random Forest classification of a 2019 Sentinel-2 composite into
 * four classes, with accuracy assessment, per-class area statistics and exports.
 *
 * Author : Satria Tesa Vici Andi (github.com/satriatva)
 * Runtime: Google Earth Engine Code Editor (https://code.earthengine.google.com)
 *
 * Workflow adapted from the "End-to-End Google Earth Engine" course by
 * Ujaval Gandhi / Spatial Thoughts (https://courses.spatialthoughts.com).
 *
 * BEFORE YOU RUN
 * Training samples are not part of this script. Provide them in ONE of two ways:
 *   A) Draw four geometry imports in the Code Editor named
 *      urban, bare, water, vegetation  (FeatureCollection type), each feature
 *      carrying an integer property 'landcover' that follows the CLASSES table below.
 *   B) Load the exported sample asset by uncommenting the line in STEP 5.
 */

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
var START_DATE = '2019-01-01';
var END_DATE = '2020-01-01';
var MAX_CLOUDY_PERCENT = 30;   // scene-level filter
var CS_CLEAR_THRESHOLD = 0.5;  // Cloud Score+ pixel-level threshold
var SCALE = 10;                // metres
var N_TREES = 50;              // Random Forest trees
var TRAIN_RATIO = 0.7;         // 70% training / 30% validation
var SEED = 42;                 // reproducible train/validation split
var EXPORT_FOLDER = 'gee-land-cover-classification';

// Class codes (property 'landcover') and display colours
var CLASSES = {
  names: ['Built-up', 'Bare land', 'Water', 'Vegetation'],
  values: [0, 1, 2, 3],
  palette: ['#cc6d8f', '#ffc107', '#1e88e5', '#004d40']
};

// -----------------------------------------------------------------------------
// STEP 1: STUDY AREA AND INPUT DATA
// -----------------------------------------------------------------------------
var sleman = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM2_NAME', 'Sleman'));
var geometry = sleman.geometry();

var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', MAX_CLOUDY_PERCENT))
  .filter(ee.Filter.date(START_DATE, END_DATE))
  .filter(ee.Filter.bounds(geometry));

var alos = ee.ImageCollection('JAXA/ALOS/AW3D30/V3_2');

Map.centerObject(geometry, 10);

// -----------------------------------------------------------------------------
// STEP 2: CLOUD MASKING WITH CLOUD SCORE+
// -----------------------------------------------------------------------------
var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
var csPlusBands = csPlus.first().bandNames();
var s2WithCs = s2.linkCollection(csPlus, csPlusBands);

function maskLowQA(image) {
  var mask = image.select('cs').gte(CS_CLEAR_THRESHOLD);
  return image.updateMask(mask);
}

var composite = s2WithCs.map(maskLowQA).select('B.*').median();

// -----------------------------------------------------------------------------
// STEP 3: SPECTRAL INDICES AND TERRAIN FEATURES
// -----------------------------------------------------------------------------
function addIndices(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('ndvi');    // vegetation
  var ndbi = image.normalizedDifference(['B11', 'B8']).rename('ndbi');   // built-up
  var mndwi = image.normalizedDifference(['B3', 'B11']).rename('mndwi'); // water
  var bsi = image.expression(                                            // bare soil
    '((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))', {
      SWIR1: image.select('B11'),
      RED: image.select('B4'),
      NIR: image.select('B8'),
      BLUE: image.select('B2')
    }).rename('bsi');
  return image.addBands([ndvi, ndbi, mndwi, bsi]);
}

// ALOS World 3D is a tiled collection: mosaic it and restore the projection
// so that slope is computed correctly.
var proj = alos.first().projection();
var elevation = alos.select('DSM').mosaic()
  .setDefaultProjection(proj)
  .rename('elev');
var slope = ee.Terrain.slope(elevation).rename('slope');

composite = addIndices(composite).addBands([elevation, slope]);

Map.addLayer(composite.clip(geometry),
  {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000, gamma: 1.2},
  'Sentinel-2 true colour (2019 median)');

// -----------------------------------------------------------------------------
// STEP 4: MIN-MAX NORMALISATION (all features scaled to 0-1)
// -----------------------------------------------------------------------------
function normalize(image) {
  var bandNames = image.bandNames();
  var minDict = image.reduceRegion({
    reducer: ee.Reducer.min(), geometry: geometry, scale: SCALE,
    maxPixels: 1e9, bestEffort: true, tileScale: 16
  });
  var maxDict = image.reduceRegion({
    reducer: ee.Reducer.max(), geometry: geometry, scale: SCALE,
    maxPixels: 1e9, bestEffort: true, tileScale: 16
  });
  var mins = ee.Image.constant(minDict.values(bandNames));
  var maxs = ee.Image.constant(maxDict.values(bandNames));
  return image.subtract(mins).divide(maxs.subtract(mins)).rename(bandNames);
}

var features = normalize(composite);

// -----------------------------------------------------------------------------
// STEP 5: TRAINING AND VALIDATION SAMPLES
// -----------------------------------------------------------------------------
// Option A: geometry imports drawn in the Code Editor
var samples = urban.merge(bare).merge(water).merge(vegetation);
// Option B: exported sample asset (see STEP 10)
// var samples = ee.FeatureCollection('projects/<your-project>/assets/sleman_lc_samples_2019');

samples = samples.randomColumn('random', SEED);
var trainingSamples = samples.filter(ee.Filter.lt('random', TRAIN_RATIO));
var validationSamples = samples.filter(ee.Filter.gte('random', TRAIN_RATIO));

var training = features.sampleRegions({
  collection: trainingSamples,
  properties: ['landcover'],
  scale: SCALE,
  tileScale: 16
});
print('Training pixels', training.size());

// -----------------------------------------------------------------------------
// STEP 6: RANDOM FOREST CLASSIFICATION
// -----------------------------------------------------------------------------
var classifier = ee.Classifier.smileRandomForest(N_TREES).train({
  features: training,
  classProperty: 'landcover',
  inputProperties: features.bandNames()
});

var classified = features.classify(classifier).clip(geometry);

Map.addLayer(classified,
  {min: 0, max: 3, palette: CLASSES.palette},
  'Land cover 2019 (Random Forest)');

// Feature importance: which bands and indices the model relied on most
var importance = ee.Dictionary(classifier.explain().get('importance'));
var importanceFc = ee.FeatureCollection(importance.keys().map(function (band) {
  return ee.Feature(null, {band: band, importance: importance.get(band)});
}));
print(ui.Chart.feature.byFeature(importanceFc.sort('importance', false), 'band', 'importance')
  .setChartType('ColumnChart')
  .setOptions({title: 'Random Forest feature importance', legend: {position: 'none'}}));

// -----------------------------------------------------------------------------
// STEP 7: ACCURACY ASSESSMENT (independent 30% validation set)
// -----------------------------------------------------------------------------
var validation = classified.sampleRegions({
  collection: validationSamples,
  properties: ['landcover'],
  scale: SCALE,
  tileScale: 16
});

var confusionMatrix = validation.errorMatrix('landcover', 'classification');
print('Confusion matrix (rows = reference, columns = predicted)', confusionMatrix);
print('Overall accuracy', confusionMatrix.accuracy());
print('Kappa coefficient', confusionMatrix.kappa());
print("Producer's accuracy (per class)", confusionMatrix.producersAccuracy());
print("User's accuracy (per class)", confusionMatrix.consumersAccuracy());

// -----------------------------------------------------------------------------
// STEP 8: AREA STATISTICS
// -----------------------------------------------------------------------------
var regencyAreaKm2 = ee.Number(geometry.area()).divide(1e6);
print('Sleman Regency area (km²)', regencyAreaKm2.round());

// Area of every class in one pass using a grouped reducer
var classAreas = ee.Image.pixelArea().divide(1e6)
  .addBands(classified)
  .reduceRegion({
    reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'class'}),
    geometry: geometry,
    scale: SCALE,
    maxPixels: 1e10,
    tileScale: 16
  });

var classAreaFc = ee.FeatureCollection(ee.List(classAreas.get('groups')).map(function (item) {
  var d = ee.Dictionary(item);
  var code = ee.Number(d.get('class'));
  var areaKm2 = ee.Number(d.get('sum'));
  return ee.Feature(null, {
    class_code: code,
    class_name: ee.List(CLASSES.names).get(code),
    area_km2: areaKm2,
    percent: areaKm2.divide(regencyAreaKm2).multiply(100)
  });
}));
print('Area per class', classAreaFc);
print(ui.Chart.feature.byFeature(classAreaFc, 'class_name', 'area_km2')
  .setChartType('ColumnChart')
  .setOptions({title: 'Land cover area, Sleman 2019 (km²)', legend: {position: 'none'},
               colors: ['#004d40']}));

// Green cover layer (vegetation class only)
var vegetationMask = classified.eq(3).selfMask();
Map.addLayer(vegetationMask, {palette: ['#004d40']}, 'Vegetation cover', false);

// -----------------------------------------------------------------------------
// STEP 9: EXPORTS
// -----------------------------------------------------------------------------
// Classified raster. Integer classes are cast to float so masked pixels are
// written as NaN; set them to NoData afterwards with:
//   gdal_translate -a_nodata nan classified.tif classified_nodata.tif
Export.image.toDrive({
  image: classified.toFloat(),
  description: 'Export_Classified_Image',
  folder: EXPORT_FOLDER,
  fileNamePrefix: 'sleman_landcover_2019',
  region: geometry,
  scale: SCALE,
  maxPixels: 1e10
});

// Accuracy metrics as CSV
var accuracyFc = ee.FeatureCollection([
  ee.Feature(null, {
    overall_accuracy: confusionMatrix.accuracy(),
    kappa: confusionMatrix.kappa(),
    confusion_matrix: confusionMatrix.array(),
    producers_accuracy: confusionMatrix.producersAccuracy(),
    users_accuracy: confusionMatrix.consumersAccuracy()
  })
]);
Export.table.toDrive({
  collection: accuracyFc,
  description: 'Export_Accuracy_Assessment',
  folder: EXPORT_FOLDER,
  fileNamePrefix: 'sleman_accuracy_2019',
  fileFormat: 'CSV'
});

// Area per class as CSV
Export.table.toDrive({
  collection: classAreaFc,
  description: 'Export_Class_Areas',
  folder: EXPORT_FOLDER,
  fileNamePrefix: 'sleman_class_areas_2019',
  fileFormat: 'CSV',
  selectors: ['class_code', 'class_name', 'area_km2', 'percent']
});

// -----------------------------------------------------------------------------
// STEP 10 (ONE-OFF): SAVE THE TRAINING SAMPLES FOR REPRODUCIBILITY
// -----------------------------------------------------------------------------
// Run once after drawing the samples, then commit the GeoJSON to data/ and
// switch STEP 5 to Option B.
Export.table.toDrive({
  collection: samples,
  description: 'Export_Training_Samples_GeoJSON',
  folder: EXPORT_FOLDER,
  fileNamePrefix: 'sleman_lc_samples_2019',
  fileFormat: 'GeoJSON'
});
Export.table.toAsset({
  collection: samples,
  description: 'Export_Training_Samples_Asset',
  // Cloud-project users: use 'projects/<your-project>/assets/sleman_lc_samples_2019'
  assetId: 'sleman_lc_samples_2019'
});

// -----------------------------------------------------------------------------
// MAP LEGEND
// -----------------------------------------------------------------------------
var legend = ui.Panel({style: {position: 'bottom-left', padding: '8px 12px'}});
legend.add(ui.Label('Land cover 2019', {fontWeight: 'bold', margin: '0 0 6px 0'}));
CLASSES.names.forEach(function (name, i) {
  legend.add(ui.Panel([
    ui.Label('', {backgroundColor: CLASSES.palette[i], padding: '8px', margin: '0 6px 4px 0'}),
    ui.Label(name, {margin: '0 0 4px 0'})
  ], ui.Panel.Layout.Flow('horizontal')));
});
Map.add(legend);
