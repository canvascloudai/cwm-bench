resource "google_monitoring_dashboard" "main" {
  dashboard_json = jsonencode({
    displayName = "${local.name}-${local.id_slug}"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 12
          height = 2
          widget = {
            text = {
              content = "cwm-bench ${var.test_id}. Empty until a campaign runs. Not a measurement. Cloud SQL has no BurstBalance metric."
              format  = "MARKDOWN"
            }
          }
        }
      ]
    }
  })
}
